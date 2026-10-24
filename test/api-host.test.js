import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApiHost } from '../src/runtime/api-host.js';

function fixture() {
  const app = express();
  app.get('/api/example', (_req, res) => res.json({ existingRoute: true }));
  const checkDatabase = vi.fn(async () => {});
  const checkStorage = vi.fn(async () => {});
  let clock = 1000;
  return { ...createApiHost({ app, checkDatabase, checkStorage, now: () => clock }),
    checkDatabase, checkStorage, advance: () => { clock += 30_001; } };
}
describe('request-only production host', () => {
  it('retains existing application routes', async () => {
    const f = fixture();
    expect((await request(f.host).get('/api/example')).body).toEqual({ existingRoute: true });
  });
  it('separates process liveness from dependency readiness', async () => {
    const f = fixture();
    expect((await request(f.host).get('/healthz/live')).status).toBe(200);
    expect(f.checkDatabase).not.toHaveBeenCalled();
    const ready = await request(f.host).get('/healthz/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ready' });
    expect(ready.headers['cache-control']).toBe('no-store');
    expect(f.checkDatabase).toHaveBeenCalledOnce();
    expect(f.checkStorage).toHaveBeenCalledOnce();
  });
  it('shares concurrent checks and rechecks after the bounded cache expires', async () => {
    const f = fixture();
    await Promise.all([f.preflight(), f.preflight(), f.preflight()]);
    expect(f.checkStorage).toHaveBeenCalledOnce();
    await f.preflight();
    expect(f.checkStorage).toHaveBeenCalledOnce();
    f.advance();
    await f.preflight();
    expect(f.checkStorage).toHaveBeenCalledTimes(2);
  });
  it.each(['checkDatabase', 'checkStorage'])('returns a sanitised failure and retries: %s', async dependency => {
    const f = fixture();
    f[dependency].mockRejectedValueOnce(new Error('synthetic-sensitive-provider-details'));
    const failure = await request(f.host).get('/healthz/ready');
    expect(failure.status).toBe(503);
    expect(failure.body).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(failure.body)).not.toContain('provider-details');
    expect((await request(f.host).get('/healthz/ready')).status).toBe(200);
  });
  it('rejects new traffic while draining and does not reuse cached readiness', async () => {
    const f = fixture();
    await f.preflight();
    f.drain();
    expect((await request(f.host).get('/healthz/live')).status).toBe(503);
    expect((await request(f.host).get('/healthz/ready')).status).toBe(503);
    const result = await request(f.host).get('/api/example');
    expect(result.status).toBe(503);
    expect(result.headers['retry-after']).toBe('5');
    await expect(f.preflight()).rejects.toThrow('RUNTIME_DRAINING');
  });
});
