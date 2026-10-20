import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleContent } from '../src/modules/ai/ai.provider.js';
const { Response } = globalThis;
const payload = { systemInstruction: { parts: [{ text: 'Synthetic instructions.' }] }, contents: [{ role: 'user', parts: [{ text: 'Synthetic question.' }] }], generationConfig: { temperature: 0, maxOutputTokens: 2048 } };
const env = { SABI_AI_PROVIDER: 'vertex', SABI_AI_AUTH_MODE: 'adc', SABI_AI_GOOGLE_PROJECT_ID: 'synthetic-project', SABI_AI_MODEL: 'gemini-synthetic' };
const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
beforeEach(() => Object.assign(process.env, env));
afterEach(() => { vi.unstubAllGlobals(); for (const key of Object.keys(env)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
describe('model-token preflight and accounting', () => {
  it('counts the full prompt before generation and bounds output to the reserved allocation', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ totalTokens: 500 })).mockResolvedValueOnce(Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Synthetic answer.' }] } }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 10, thoughtsTokenCount: 20, totalTokenCount: 530 } }));
    vi.stubGlobal('fetch', fetcher);
    const result = await googleContent(payload, { tokenBudget: 1000, authorize: async () => ({ Authorization: 'Bearer synthetic' }) });
    expect(String(fetcher.mock.calls[0][0])).toMatch(/:countTokens$/); expect(String(fetcher.mock.calls[1][0])).toMatch(/:generateContent$/);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).generationConfig.maxOutputTokens).toBe(468);
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 30, totalTokens: 530 });
  });
  it('does not dispatch generation when the prompt exceeds the reserved balance', async () => {
    const fetcher = vi.fn(async () => Response.json({ totalTokens: 2000 })); vi.stubGlobal('fetch', fetcher);
    await expect(googleContent(payload, { tokenBudget: 1000, authorize: async () => ({}) })).rejects.toMatchObject({ code: 'AI_TOKEN_QUOTA', aiProviderDispatched: false }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('retains reported usage for incomplete answers rather than making them free', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ totalTokens: 100 })).mockResolvedValueOnce(Response.json({ candidates: [{ finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 } })));
    await expect(googleContent(payload, { tokenBudget: 1000, authorize: async () => ({}) })).rejects.toMatchObject({ code: 'AI_RESPONSE_INCOMPLETE', aiProviderDispatched: true, usage: { totalTokens: 150 } });
  });
  it('does not fabricate zero usage if generation returned no usage metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ totalTokens: 100 })).mockResolvedValueOnce(Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Synthetic answer' }] } }] })));
    await expect(googleContent(payload, { tokenBudget: 1000, authorize: async () => ({}) })).rejects.toMatchObject({ code: 'AI_USAGE_INVALID', aiProviderDispatched: true });
  });
});
