// The linked EMDEX documentation supplies request paths, but no response examples.
// Keep this server-only transport separate from a licensed, verified product normalizer.
import { z } from 'zod';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
const { FormData } = globalThis;
const routes = {
  brandSearch: { path: '/brand/search', schema: z.object({ keyword: z.string().trim().min(2).max(120), form: z.string().trim().max(80).default(''), strength: z.string().trim().max(80).default('') }).strict() },
  brandDetails: { path: '/brand/', schema: z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/) }).strict() },
  genericSearch: { path: '/generic/search', schema: z.object({ keyword: z.string().trim().min(2).max(120) }).strict() },
  genericDetails: { path: '/generic', schema: z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/) }).strict() },
};
export const emdexError = (code, status = 503) => Object.assign(new Error('Medicine catalogue information is unavailable. No product or regimen has been inferred.'), { code, status });
const isEmdexError = (error) => typeof error?.code === 'string' && error.code.startsWith('EMDEX_');
function baseUrl(value) {
  let url; try { url = new URL(value); } catch { throw emdexError('EMDEX_NOT_CONFIGURED'); }
  // Only the provider's documented sandbox is authorised by the current contract.
  // Production host must be verified against the licensed account before adding it.
  if (url.protocol !== 'https:' || url.hostname !== 'sandbox.emdexapi.com' || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/api/v1') throw emdexError('EMDEX_ENDPOINT_NOT_VERIFIED');
  return url.toString().replace(/\/$/, '');
}
export async function emdexRequest(operation, input, { base = process.env.EMDEX_API_BASE_URL, token = process.env.EMDEX_API_TOKEN, fetcher = globalThis.fetch, signal } = {}) {
  const route = routes[operation]; if (!route) throw emdexError('EMDEX_OPERATION_UNSUPPORTED', 422);
  const parsed = route.schema.safeParse(input); if (!parsed.success) throw emdexError('EMDEX_REQUEST_INVALID', 422);
  const endpoint = baseUrl(base);
  if (!token || /\s/.test(token)) throw emdexError('EMDEX_NOT_CONFIGURED');
  if (signal?.aborted) throw emdexError('EMDEX_CANCELLED');
  // Documented multipart form data. No content-type override: fetch must set the boundary.
  const body = new FormData(); for (const [key, value] of Object.entries(parsed.data)) body.append(key, value);
  try {
    const response = await fetcher(`${endpoint}${route.path}`, { method: 'POST', redirect: 'error', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, body,
      signal: globalThis.AbortSignal.any([globalThis.AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw emdexError(response.status === 429 ? 'EMDEX_PROVIDER_BUSY' : [401,403].includes(response.status) ? 'EMDEX_AUTH_UNAVAILABLE' : 'EMDEX_PROVIDER_UNAVAILABLE'); }
    const reader = response.body?.getReader(); if (!reader) throw emdexError('EMDEX_RESPONSE_INVALID');
    const chunks = []; let bytes = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 512000) throw emdexError('EMDEX_RESPONSE_TOO_LARGE'); chunks.push(Buffer.from(value)); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (data === null || typeof data !== 'object') throw emdexError('EMDEX_RESPONSE_INVALID');
      // Raw data stays inside this provider boundary. It is NOT a trusted medicine record,
      // must not enter a prompt/UI, and must not be cached until the licence permits it.
      return { provider: 'EMDEX', operation, receivedAt: new Date(), data, normalized: false };
    } catch (error) { await reader.cancel().catch(() => {}); throw isEmdexError(error) ? error : emdexError('EMDEX_RESPONSE_INVALID'); }
  } catch (error) { throw isEmdexError(error) ? error : emdexError(signal?.aborted ? 'EMDEX_CANCELLED' : 'EMDEX_PROVIDER_UNAVAILABLE'); }
}
export const emdexCapabilities = () => ({ provider: 'EMDEX', credentialsConfigured: Boolean(process.env.EMDEX_API_BASE_URL && process.env.EMDEX_API_TOKEN),
  responseContractVerified: false, licensedCacheVerified: false, prescribingSafetyChecks: false, inventoryAuthority: false,
});
