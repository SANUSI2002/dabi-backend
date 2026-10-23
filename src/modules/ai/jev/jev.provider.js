import { z } from 'zod';
import { Buffer } from 'node:buffer';

const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/).refine((s) => !['constructor', 'prototype'].includes(s));
const text = z.string().trim().min(1).max(4000);
const probability = z.number().finite().min(0).max(1);
const description = z.string().trim().min(1).max(2000);
const question = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), instructions: text, criteria: z.record(name, description).refine((c) => Object.keys(c).length >= 2 && Object.keys(c).length <= 255) }).strict(),
  z.object({ type: z.literal('score'), instructions: text, criteria: z.array(description).min(2).max(10) }).strict(),
  z.object({ type: z.literal('noul'), instructions: text, criteria: z.object({ true: description, false: description }).strict().optional() }).strict(),
]);
const requestSchema = z.object({ model: z.string().regex(/^jev-[a-zA-Z0-9.-]{1,100}$/), state: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]),
  questions: z.record(name, question).refine((q) => Object.keys(q).length > 0 && Object.keys(q).length <= 30),
}).strict();
const root = z.object({ model: z.string().regex(/^jev-[a-zA-Z0-9.-]{1,100}$/), answers: z.record(name, z.unknown()),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});
export const jevError = (code, status = 503) => Object.assign(new Error('The structured assessment service is unavailable. Manual workflows remain available.'), { code, status });
const invalid = () => jevError('JEV_RESPONSE_INVALID');
const isJevError = (error) => typeof error?.code === 'string' && error.code.startsWith('JEV_');
const exactKeys = (record, expected) => Object.keys(record).length === expected.length && expected.every((key) => Object.hasOwn(record, key));

/** Application-owned typed questions only; this module is never mounted as a raw browser proxy. */
export function validateJevRequest(input) {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw jevError('JEV_REQUEST_INVALID', 422);
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(parsed.data)); } catch { throw jevError('JEV_REQUEST_INVALID', 422); }
  // Application bound, not a claim about the vendor's context limit. Never truncate evidence.
  if (bytes > 60000) throw jevError('JEV_CONTEXT_TOO_LARGE', 422);
  return parsed.data;
}
export function validateJevResponse(body, input) {
  const parsed = root.safeParse(body); if (!parsed.success) throw invalid();
  const result = parsed.data;
  if (!exactKeys(result.answers, Object.keys(input.questions))) throw invalid();
  if (/^jev-\d+\.\d+\.\d+$/.test(input.model) && result.model !== input.model) throw jevError('JEV_MODEL_CHANGED');
  const answers = Object.create(null);
  for (const [key, q] of Object.entries(input.questions)) {
    const a = result.answers[key];
    if (q.type === 'noul') {
      const value = z.object({ type: z.literal('noul'), noul: probability }).strict().safeParse(a);
      if (!value.success) throw invalid(); answers[key] = value.data; continue;
    }
    const common = { type: z.literal(q.type), confidence: probability, probabilities: z.record(z.string(), probability) };
    const schema = q.type === 'choice' ? z.object({ ...common, choice: z.string() }).strict()
      : z.object({ ...common, score: z.number().finite().min(0).max(q.criteria.length - 1), legend: z.record(z.string(), description) }).strict();
    const value = schema.safeParse(a); if (!value.success) throw invalid();
    const answer = value.data;
    const keys = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    if (!exactKeys(answer.probabilities, keys) || Math.abs(Object.values(answer.probabilities).reduce((sum, n) => sum + n, 0) - 1) > 0.02) throw invalid();
    if (q.type === 'choice') {
      if (!keys.includes(answer.choice) || answer.probabilities[answer.choice] < Math.max(...Object.values(answer.probabilities))) throw invalid();
    } else {
      if (!exactKeys(answer.legend, keys) || keys.some((k) => answer.legend[k] !== q.criteria[Number(k)])) throw invalid();
      const mean = keys.reduce((sum, k) => sum + Number(k) * answer.probabilities[k], 0);
      if (Math.abs(mean - answer.score) > 0.025) throw invalid();
    }
    answers[key] = answer;
  }
  return { model: result.model, answers, usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens } };
}
async function responseJson(response, maximum = 256000) {
  const reader = response.body?.getReader(); if (!reader) throw invalid();
  const chunks = []; let bytes = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > maximum) throw invalid(); chunks.push(Buffer.from(value)); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { await reader.cancel().catch(() => {}); throw isJevError(error) ? error : invalid(); }
}
export async function evaluateJev(input, { apiKey = process.env.TYPESAFE_API_KEY, fetcher = globalThis.fetch, signal, timeoutMs = 8000 } = {}) {
  const request = validateJevRequest(input);
  if (!apiKey || /\s/.test(apiKey)) throw jevError('JEV_NOT_CONFIGURED');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 20000) throw jevError('JEV_CONFIGURATION_INVALID');
  if (signal?.aborted) throw jevError('JEV_CANCELLED');
  try {
    const response = await fetcher('https://api.typesafe.ai/v1/systemone', { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(request), signal: globalThis.AbortSignal.any([globalThis.AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw jevError(response.status === 429 ? 'JEV_PROVIDER_BUSY' : response.status === 401 || response.status === 403 ? 'JEV_AUTH_UNAVAILABLE' : 'JEV_PROVIDER_UNAVAILABLE'); }
    return validateJevResponse(await responseJson(response), request);
  } catch (error) { throw isJevError(error) ? error : jevError(signal?.aborted ? 'JEV_CANCELLED' : 'JEV_PROVIDER_UNAVAILABLE'); }
}
export async function listJevModels({ apiKey = process.env.TYPESAFE_API_KEY, fetcher = globalThis.fetch } = {}) {
  if (!apiKey || /\s/.test(apiKey)) throw jevError('JEV_NOT_CONFIGURED');
  try {
    const response = await fetcher('https://api.typesafe.ai/v1/models', { redirect: 'error', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, signal: globalThis.AbortSignal.timeout(8000) });
    if (!response.ok) throw jevError('JEV_MODEL_DISCOVERY_UNAVAILABLE');
    const body = await responseJson(response);
    const parsed = z.object({ models: z.array(z.object({ name: z.string().max(120), description: z.string().max(4000), release_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })).max(100) }).safeParse(body);
    if (!parsed.success) throw invalid(); return parsed.data.models;
  } catch (error) { throw isJevError(error) ? error : jevError('JEV_MODEL_DISCOVERY_UNAVAILABLE'); }
}
