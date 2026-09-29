// Webhook delivery safety and rate-limiter resilience (no database).
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/db.js', () => ({ default: {} }));

const { checkedLookup, postWebhook } = await import('../src/modules/emr/core/outbox.js');
const { tenantRateLimit, setTenantRateLimitStore, resetTenantRateLimits } = await import('../src/modules/emr/core/rateLimit.js');
const { logger } = await import('../src/modules/emr/core/logging.js');

const resolving = (addresses) => (hostname, options, callback) => callback(null, addresses);
const lookupResult = (lookup, options = {}) => new Promise((resolve) => {
  lookup('hooks.example.com', options, (error, address, family) => resolve({ error, address, family }));
});

afterEach(() => { delete process.env.EMR_WEBHOOK_ALLOW_LOCAL; });

describe('webhook address checks happen in the connection itself', () => {
  it('refuses a host that resolves to any private address', async () => {
    for (const addresses of [[{ address: '10.0.0.5', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }], [{ address: '::1', family: 6 }], []]) {
      const { error } = await lookupResult(checkedLookup(resolving(addresses)));
      expect(error?.code ?? error?.message).toMatch(/EPRIVATEADDRESS|private/);
    }
  });

  it('passes public addresses through in both lookup forms', async () => {
    const lookup = checkedLookup(resolving([{ address: '93.184.216.34', family: 4 }]));
    expect(await lookupResult(lookup)).toMatchObject({ error: null, address: '93.184.216.34', family: 4 });
    expect((await lookupResult(lookup, { all: true })).address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('refuses private IP literals without any lookup', async () => {
    await expect(postWebhook('https://10.1.2.3/hook', { headers: {}, body: '{}', timeoutMs: 1000 })).rejects.toThrow(/private/);
    await expect(postWebhook('https://[::1]/hook', { headers: {}, body: '{}', timeoutMs: 1000 })).rejects.toThrow(/private/);
  });

  describe('against a real local server', () => {
    let server;
    let received;
    let port;
    beforeEach(async () => {
      received = null;
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => { received = { headers: req.headers, body }; res.writeHead(302, { location: 'http://169.254.169.254/' }).end(); });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = server.address().port;
    });
    afterEach(() => new Promise((resolve) => server.close(resolve)));

    it('blocks a hostname that resolves to loopback (the check runs in the socket lookup)', async () => {
      await expect(postWebhook(`http://localhost:${port}/hook`, { headers: {}, body: '{}', timeoutMs: 2000 })).rejects.toThrow(/private/);
      expect(received).toBeNull();
    });

    it('when local delivery is allowed (dev/test only), posts the body and does not follow redirects', async () => {
      process.env.EMR_WEBHOOK_ALLOW_LOCAL = 'true';
      const response = await postWebhook(`http://localhost:${port}/hook`, { headers: { 'x-sabi-event': 'patient.registered' }, body: '{"id":1}', timeoutMs: 2000 });
      expect(response.status).toBe(302); // a redirect is a failed delivery, never followed
      expect(received).toMatchObject({ body: '{"id":1}', headers: { 'x-sabi-event': 'patient.registered', 'content-length': '8' } });
    });
  });
});

describe('per-tenant rate limit store failures', () => {
  afterEach(() => { resetTenantRateLimits(); vi.restoreAllMocks(); });

  it('fails open but logs the failure, at most once a minute', async () => {
    const warn = vi.spyOn(logger, 'warn');
    setTenantRateLimitStore({ hit: () => Promise.reject(Object.assign(new Error('store down'), { code: 'ECONNREFUSED' })) });
    const next = vi.fn();
    const req = { emr: { organizationId: 'org-1' } };
    const res = { set: vi.fn() };
    await tenantRateLimit(req, res, next);
    await tenantRateLimit(req, res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(next.mock.calls.every((call) => call.length === 0)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('emr.rate_limit.store_failed', { name: 'Error', code: 'ECONNREFUSED' });
  });
});
