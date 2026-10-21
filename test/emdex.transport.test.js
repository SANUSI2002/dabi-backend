import { describe, expect, it, vi } from 'vitest';
import { emdexRequest, emdexCapabilities } from '../src/modules/emr/pharmacy/emdex.transport.js';
const { Response, FormData, AbortController } = globalThis;
const settings = { base: 'https://sandbox.emdexapi.com/api/v1', token: 'synthetic-token' };
describe('EMDEX documented transport preparation', () => {
  it.each([['brandSearch', { keyword: 'Synthetic brand' }, '/brand/search'], ['brandDetails', { id: '10' }, '/brand/'], ['genericSearch', { keyword: 'Synthetic generic' }, '/generic/search'], ['genericDetails', { id: '56' }, '/generic']])('sends %s as documented multipart data, not a patient regimen', async (operation, input, suffix) => {
    const fetcher = vi.fn(async () => Response.json({ providerFixture: true }));
    const result = await emdexRequest(operation, input, { ...settings, fetcher });
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe(`${settings.base}${suffix}`); expect(options.method).toBe('POST'); expect(options.redirect).toBe('error');
    expect(options.body).toBeInstanceOf(FormData); expect(options.headers.Authorization).toBe('Bearer synthetic-token'); expect(options.headers).not.toHaveProperty('Content-Type');
    expect(result).toMatchObject({ provider: 'EMDEX', normalized: false }); expect(result).not.toHaveProperty('dosage'); expect(result).not.toHaveProperty('stock');
  });
  it.each(['http://sandbox.emdexapi.com/api/v1', 'https://attacker.example/api/v1', 'https://sandbox.emdexapi.com.evil.test/api/v1', 'https://sandbox.emdexapi.com/api/v1?token=leak', 'https://user:pass@sandbox.emdexapi.com/api/v1'])('rejects an unverified destination %s', async (base) => {
    const fetcher = vi.fn(); await expect(emdexRequest('brandSearch', { keyword: 'test' }, { ...settings, base, fetcher })).rejects.toMatchObject({ code: 'EMDEX_ENDPOINT_NOT_VERIFIED' }); expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not turn catalogue access into clinical checks or use documentation sample credentials', async () => {
    const fetcher = vi.fn(); await expect(emdexRequest('brandSearch', { keyword: 'test' }, { ...settings, token: '', fetcher })).rejects.toMatchObject({ code: 'EMDEX_NOT_CONFIGURED' });
    await expect(emdexRequest('login', { email: 'sample@example.test', password: 'sample' }, { ...settings, fetcher })).rejects.toMatchObject({ code: 'EMDEX_OPERATION_UNSUPPORTED' });
    await expect(emdexRequest('brandSearch', { keyword: 'test', patientId: 'forged', dose: 500 }, { ...settings, fetcher })).rejects.toMatchObject({ code: 'EMDEX_REQUEST_INVALID' });
    expect(fetcher).not.toHaveBeenCalled(); expect(emdexCapabilities()).toMatchObject({ responseContractVerified: false, prescribingSafetyChecks: false, inventoryAuthority: false });
  });
  it.each([401,429,503])('never fabricates products on HTTP %s', async (status) => {
    await expect(emdexRequest('brandSearch', { keyword: 'test' }, { ...settings, fetcher: async () => new Response('private error', { status }) })).rejects.toMatchObject({ status: 503 });
  });
  it('rejects invalid or oversized responses and stops cancelled requests before network access', async () => {
    for (const body of ['not JSON', 'null', 'x'.repeat(512001)]) await expect(emdexRequest('genericSearch', { keyword: 'test' }, { ...settings, fetcher: async () => new Response(body) })).rejects.toMatchObject({ status: 503 });
    const controller = new AbortController(); controller.abort(); const fetcher = vi.fn();
    await expect(emdexRequest('genericSearch', { keyword: 'test' }, { ...settings, signal: controller.signal, fetcher })).rejects.toMatchObject({ code: 'EMDEX_CANCELLED' }); expect(fetcher).not.toHaveBeenCalled();
  });
});
