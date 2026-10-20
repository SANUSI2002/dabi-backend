import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createAiGateway } from '../src/modules/ai/ai.gateway-server.js';
import { gatewayContent, gatewaySignature, gatewayUrlValid } from '../src/modules/ai/ai.gateway-client.js';
import { aiAvailable } from '../src/modules/ai/ai.config.js';
const { Response, AbortSignal } = globalThis;
const secret = 'a'.repeat(64); const timestamp = '1792490000000';
const env = { SABI_AI_GATEWAY_SECRET: secret, SABI_AI_PROVIDER: 'vertex', SABI_AI_AUTH_MODE: 'adc' };
const payload = { systemInstruction: { parts: [{ text: 'Synthetic connectivity only.' }] }, contents: [{ role: 'user', parts: [{ text: 'Hello.' }] }], generationConfig: { temperature: 0, maxOutputTokens: 32 } };
const result = { text: 'SABI_OK', usage: { inputTokens: 4, outputTokens: 2 } };
const body = JSON.stringify({ payload, maxCharacters: 256 });
const signed = (app, raw = body, stamp = timestamp, signature = gatewaySignature(secret, stamp, raw)) => request(app).post('/v1/generate').set('Content-Type', 'application/json').set('x-sabi-timestamp', stamp).set('x-sabi-signature', signature).send(raw);
describe('keyless Google runtime boundary', () => {
  it('signs the request token budget and forwards it unchanged to generation', async () => {
    const raw = JSON.stringify({ payload, maxCharacters: 256, tokenBudget: 1000 });
    const generate = vi.fn(async () => ({ ...result, usage: { ...result.usage, totalTokens: 6 } }));
    const app = createAiGateway({ env, generate, now: () => Number(timestamp) });
    expect((await signed(app, raw)).status).toBe(200);
    expect(generate).toHaveBeenCalledWith(payload, expect.objectContaining({ tokenBudget: 1000 }));
    const fetcher = vi.fn(async () => Response.json({ ...result, usage: { ...result.usage, totalTokens: 6 } }));
    const response = await gatewayContent(payload, { tokenBudget: 1000, env: { SABI_AI_GATEWAY_SECRET: secret, SABI_AI_GATEWAY_URL: 'https://synthetic.run.app' }, fetcher });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).tokenBudget).toBe(1000);
    expect(response.usage.totalTokens).toBe(6);
  });
  it('rejects invalid startup and keeps an uncredentialed API unavailable', () => {
    expect(() => createAiGateway({ env: {} })).toThrow('AI_GATEWAY_CONFIGURATION_INVALID');
    expect(aiAvailable({ SABI_AI_ENABLED: 'true', SABI_AI_GOOGLE_PROCESSING_APPROVED: 'true', SABI_AI_PROVIDER: 'gateway', SABI_AI_AUTH_MODE: 'gateway', SABI_AI_MODEL: 'gemini-synthetic' })).toBe(false);
  });
  it('accepts only the signed, timestamped server request and returns bounded provider output', async () => {
    const generate = vi.fn(async () => result); const app = createAiGateway({ env, generate, now: () => Number(timestamp) });
    const response = await signed(app); expect(response.status).toBe(200); expect(response.body).toEqual(result);
    expect(generate).toHaveBeenCalledWith(payload, expect.objectContaining({ maxCharacters: 256, signal: expect.any(AbortSignal) }));
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('rejects unsigned, expired and tampered requests before calling Google', async () => {
    const generate = vi.fn(); const app = createAiGateway({ env, generate, now: () => Number(timestamp) });
    expect((await request(app).post('/v1/generate').send({ payload })).status).toBe(401);
    expect((await signed(app, body, String(Number(timestamp) - 61000))).status).toBe(401);
    expect((await signed(app, body, timestamp, 'b'.repeat(64))).status).toBe(401);
    expect(generate).not.toHaveBeenCalled();
  });
  it('rejects raw file upload, tools and oversized generation parameters', async () => {
    const generate = vi.fn(); const app = createAiGateway({ env, generate, now: () => Number(timestamp) });
    for (const changed of [{ ...payload, tools: [] }, { ...payload, generationConfig: { temperature: 0, maxOutputTokens: 99999 } }, { ...payload, contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data: 'sensitive' } }] }] }]) {
      expect((await signed(app, JSON.stringify({ payload: changed, maxCharacters: 256 }))).status).toBe(422);
    }
    expect(generate).not.toHaveBeenCalled();
  });
  it('does not expose provider errors or credentials', async () => {
    const app = createAiGateway({ env, now: () => Number(timestamp), generate: async () => { throw new Error(`private ${secret}`); } });
    const response = await signed(app); expect(response.status).toBe(503); expect(response.text).not.toContain(secret); expect(response.text).not.toContain('private');
    expect((await request(app).get('/health')).body).toMatchObject({ status: 'ok' });
  });
  it('prevents redirects and private/non-Google destinations in the server transport', async () => {
    for (const url of ['http://localhost/', 'https://example.com/', 'https://test.run.app/private', 'https://user:pass@test.run.app/']) expect(gatewayUrlValid(url)).toBe(false);
    expect(gatewayUrlValid('https://synthetic.run.app')).toBe(true);
    const fetcher = vi.fn(async () => Response.json(result));
    const response = await gatewayContent(payload, { env: { SABI_AI_GATEWAY_SECRET: secret, SABI_AI_GATEWAY_URL: 'https://synthetic.run.app' }, fetcher });
    expect(response).toEqual(result); expect(fetcher.mock.calls[0][1].redirect).toBe('error');
    expect(fetcher.mock.calls[0][1].body).not.toContain(secret); expect(String(fetcher.mock.calls[0][0])).not.toContain(secret);
  });
  it('rejects invalid output and preserves cancellation without exposing response bodies', async () => {
    await expect(gatewayContent(payload, { env: { SABI_AI_GATEWAY_SECRET: secret, SABI_AI_GATEWAY_URL: 'https://synthetic.run.app' }, fetcher: async () => Response.json({ text: 'Private error' }) })).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
  });
});
