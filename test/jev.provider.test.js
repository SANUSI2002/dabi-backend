import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateJev, listJevModels, validateJevRequest, validateJevResponse } from '../src/modules/ai/jev/jev.provider.js';
const { Response, AbortController } = globalThis;
const choice = { type: 'choice', instructions: 'Which review category is documented?', criteria: { named: 'A medicine name is recorded.', unresolved: 'A medicine is reported without its name.' } };
const input = { model: 'jev-1.13.0', state: { note: 'Synthetic fixture only: medicine reported, name unknown.' }, questions: { history: choice } };
const reply = () => ({ model: input.model, answers: { history: { type: 'choice', choice: 'unresolved', confidence: 1, probabilities: { named: 0, unresolved: 1 } } }, usage: { input_tokens: 100, output_tokens: 20 } });
afterEach(() => vi.unstubAllEnvs());
describe('server-only Jev typed adapter', () => {
  it('uses the documented endpoint and header, with no identifiers added or key in URLs/body', async () => {
    const fetcher = vi.fn(async () => Response.json(reply()));
    const result = await evaluateJev(input, { apiKey: 'synthetic-secret', fetcher });
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(options.headers.Authorization).toBe('Bearer synthetic-secret');
    expect(options.redirect).toBe('error'); expect(options.body).not.toContain('synthetic-secret');
    expect(JSON.parse(options.body)).toEqual(input); expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(result).not.toHaveProperty('rationale');
  });
  it('keeps Noul probability distinct from confidence and supports an ordered Score', () => {
    const request = { ...input, questions: { present: { type: 'noul', instructions: 'Is use mentioned?' }, coverage: { type: 'score', instructions: 'How is the note covered?', criteria: ['Not addressed', 'Partially addressed', 'Explicitly addressed'] } } };
    const result = validateJevResponse({ model: input.model, usage: reply().usage, answers: {
      present: { type: 'noul', noul: 0.5 }, coverage: { type: 'score', score: 1.43, confidence: 0.35, probabilities: { 0: 0, 1: 0.57, 2: 0.43 }, legend: { 0: 'Not addressed', 1: 'Partially addressed', 2: 'Explicitly addressed' } },
    } }, request);
    expect(result.answers.present).toEqual({ type: 'noul', noul: 0.5 }); expect(result.answers.coverage.score).toBe(1.43);
    expect(() => validateJevResponse({ model: input.model, usage: reply().usage, answers: { present: { type: 'noul', noul: 0.5, confidence: 1 } } }, { ...input, questions: { present: request.questions.present } })).toThrow();
  });
  it.each([
    (b) => { delete b.answers.history; },
    (b) => { b.answers.extra = b.answers.history; },
    (b) => { b.answers.history.choice = 'invented'; },
    (b) => { b.answers.history.confidence = NaN; },
    (b) => { b.answers.history.probabilities.named = -0.2; },
    (b) => { b.answers.history.probabilities.named = 0.5; },
    (b) => { b.answers.history.choice = 'named'; },
    (b) => { b.model = 'jev-1.14.0'; },
    (b) => { b.usage.input_tokens = -1; },
  ])('rejects incomplete, contradictory or unpinned responses %#', (change) => {
    const body = reply(); change(body); expect(() => validateJevResponse(body, input)).toThrow();
  });
  it('rejects preview image/box fields, arbitrary endpoints and oversize state rather than truncating', () => {
    expect(() => validateJevRequest({ ...input, assets: { scan: 'not allowed' } })).toThrow();
    expect(() => validateJevRequest({ ...input, endpoint: 'https://attacker.example' })).toThrow();
    expect(() => validateJevRequest({ ...input, state: 'x'.repeat(60001) })).toThrow();
    expect(() => validateJevRequest({ ...input, questions: { scan: { type: 'box', instructions: 'Diagnose image' } } })).toThrow();
  });
  it.each([401, 403, 429, 500])('fails safely on HTTP %s without echoing provider details or retrying', async (status) => {
    const fetcher = vi.fn(async () => new Response('private key and patient contents', { status }));
    await expect(evaluateJev(input, { apiKey: 'synthetic-secret', fetcher })).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects missing credentials before any call and aborts without exposing transport errors', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', ''); const fetcher = vi.fn();
    await expect(evaluateJev(input, { fetcher })).rejects.toMatchObject({ code: 'JEV_NOT_CONFIGURED' }); expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await expect(evaluateJev(input, { apiKey: 'synthetic', signal: controller.signal, fetcher: async (_url, o) => { o.signal.throwIfAborted(); } })).rejects.toMatchObject({ code: 'JEV_CANCELLED' });
  });
  it('rejects malformed and oversized bodies and discovers actual account models', async () => {
    for (const body of ['not json', 'x'.repeat(256001)]) await expect(evaluateJev(input, { apiKey: 'synthetic', fetcher: async () => new Response(body) })).rejects.toMatchObject({ code: 'JEV_RESPONSE_INVALID' });
    const models = [{ name: 'jev-1.13.0', description: 'Synthetic model metadata', release_date: '2026-09-15' }];
    expect(await listJevModels({ apiKey: 'synthetic', fetcher: async () => Response.json({ models }) })).toEqual(models);
  });
});
