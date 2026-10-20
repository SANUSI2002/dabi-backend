import { createHmac } from 'node:crypto';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import { aiError } from './ai.config.js';

export const gatewayUrlValid = (value) => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname.endsWith('.run.app') && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; } catch { return false; }
};
export const gatewaySignature = (secret, timestamp, body) => createHmac('sha256', secret).update(`${timestamp}\n${body}`).digest('hex');

// Only the Sabi API calls this transport; the browser never receives its shared secret.
export async function gatewayContent(payload, { signal, maxCharacters = 30000, fetcher = globalThis.fetch, env = process.env } = {}) {
  if (!gatewayUrlValid(env.SABI_AI_GATEWAY_URL) || !/^[a-f0-9]{64}$/.test(env.SABI_AI_GATEWAY_SECRET || '')) throw aiError(503, 'AI_GATEWAY_NOT_CONFIGURED', 'Sabi AI is not configured.');
  const timestamp = String(Date.now()); const body = JSON.stringify({ payload, maxCharacters });
  try {
    const response = await fetcher(new URL('/v1/generate', env.SABI_AI_GATEWAY_URL), { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'x-sabi-timestamp': timestamp, 'x-sabi-signature': gatewaySignature(env.SABI_AI_GATEWAY_SECRET, timestamp, body) },
      body, signal: globalThis.AbortSignal.any([globalThis.AbortSignal.timeout(55000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw aiError(503, 'AI_PROVIDER_UNAVAILABLE', 'Sabi could not complete this response.'); }
    const reader = response.body?.getReader(); if (!reader) throw new Error('INVALID_RESPONSE');
    const chunks = []; let size = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 150000) { await reader.cancel(); throw new Error('OVERSIZED_RESPONSE'); } chunks.push(Buffer.from(value)); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > maxCharacters || !Number.isSafeInteger(result.usage?.inputTokens) || result.usage.inputTokens < 0 || !Number.isSafeInteger(result.usage?.outputTokens) || result.usage.outputTokens < 0) throw new Error('INVALID_RESPONSE');
    return { text: result.text, usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } };
  } catch { throw aiError(503, signal?.aborted ? 'AI_CANCELLED' : 'AI_PROVIDER_UNAVAILABLE', 'Sabi could not complete this response.'); }
}
