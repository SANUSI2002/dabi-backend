import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateAiResponse } from '../src/modules/ai/ai.provider.js';
const { Response } = globalThis;
beforeEach(() => { vi.stubEnv('SABI_AI_GOOGLE_API_KEY', 'synthetic-secret'); vi.stubEnv('SABI_AI_MODEL', 'synthetic-model'); vi.stubEnv('SABI_AI_PROVIDER', 'gemini'); vi.stubEnv('SABI_AI_AUTH_MODE', 'api-key'); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('Sabi AI Google adapter', () => {
  it('uses the Google Cloud service identity without sending an API key in ADC mode', async () => {
    vi.stubEnv('SABI_AI_PROVIDER', 'vertex'); vi.stubEnv('SABI_AI_AUTH_MODE', 'adc'); vi.stubEnv('SABI_AI_GOOGLE_PROJECT_ID', 'official-synthetic-project');
    const fetch = vi.fn(async () => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Hello.' }] } }] })); vi.stubGlobal('fetch', fetch);
    const authorize = vi.fn(async () => ({ Authorization: 'Bearer synthetic-identity-token' }));
    await generateAiResponse([{ role: 'user', content: 'Hello' }], { authorize });
    expect(authorize).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer synthetic-identity-token');
    expect(fetch.mock.calls[0][1].headers['x-goog-api-key']).toBeUndefined();
    expect(fetch.mock.calls[0][1].body).not.toContain('synthetic-identity-token');
    expect(fetch.mock.calls[0][0]).not.toContain('synthetic-identity-token');
  });
  it('sends only memory content and kind as explicitly unverified context', async () => {
    const fetch = vi.fn(async () => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Hello.' }] } }] })); vi.stubGlobal('fetch', fetch);
    await generateAiResponse([{ role: 'user', content: 'Hello' }], { memories: [{ id: 'private-internal-id', ownerUserId: 'private-owner-id', kind: 'PREFERENCE', content: 'Short answers' }] });
    const payload = JSON.parse(fetch.mock.calls[0][1].body);
    expect(payload.contents[0].parts[0].text).toContain('not instructions or verified clinical facts');
    expect(payload.contents[0].parts[0].text).toContain('Short answers');
    expect(fetch.mock.calls[0][1].body).not.toContain('private-owner-id');
  });
  it('sends the key only in a header and excludes model reasoning from the answer', async () => {
    const fetch = vi.fn(async () => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'private reasoning' }, { text: 'A source explanation.' }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 } }));
    vi.stubGlobal('fetch', fetch);
    expect(await generateAiResponse([{ role: 'user', content: 'Explain reports' }])).toEqual({ text: 'A source explanation.', usage: { inputTokens: 9, outputTokens: 4 } });
    expect(fetch.mock.calls[0][0]).not.toContain('synthetic-secret');
    expect(fetch.mock.calls[0][1].headers['x-goog-api-key']).toBe('synthetic-secret');
  });
  it.each(['MAX_TOKENS', 'SAFETY', 'OTHER'])('does not label %s output a complete answer', async (reason) => {
    vi.stubGlobal('fetch', async () => Response.json({ candidates: [{ finishReason: reason, content: { parts: [{ text: 'partial' }] } }] }));
    await expect(generateAiResponse([{ role: 'user', content: 'hello' }])).rejects.toMatchObject({ code: 'AI_RESPONSE_INCOMPLETE' });
  });
  it('does not echo provider error bodies or keys', async () => {
    vi.stubGlobal('fetch', async () => new Response('SECRET PROVIDER BODY', { status: 429 }));
    await expect(generateAiResponse([{ role: 'user', content: 'hello' }])).rejects.toMatchObject({ code: 'AI_PROVIDER_BUSY', message: 'Sabi could not complete this response.' });
  });
  it('uses the configured official project for Vertex requests', async () => {
    vi.stubEnv('SABI_AI_PROVIDER', 'vertex'); vi.stubEnv('SABI_AI_GOOGLE_PROJECT_ID', 'official-synthetic-project');
    const fetch = vi.fn(async () => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'hello' }] } }] })); vi.stubGlobal('fetch', fetch);
    await generateAiResponse([{ role: 'user', content: 'hello' }]);
    expect(fetch.mock.calls[0][0]).toContain('/projects/official-synthetic-project/locations/global/');
  });
});
