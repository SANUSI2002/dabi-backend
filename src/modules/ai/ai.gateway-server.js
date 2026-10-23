import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { googleContent } from './ai.provider.js';
import { gatewaySignature } from './ai.gateway-client.js';

const parts = z.array(z.object({ text: z.string().max(200000) }).strict()).min(1).max(10);
const schema = z.object({ payload: z.object({
  systemInstruction: z.object({ parts }).strict(),
  contents: z.array(z.object({ role: z.enum(['user', 'model']), parts }).strict()).min(1).max(100),
  generationConfig: z.object({ temperature: z.number().min(0).max(1), maxOutputTokens: z.number().int().min(1).max(2048) }).strict(),
}).strict(), maxCharacters: z.number().int().min(1).max(30000), tokenBudget: z.number().int().min(128).max(64000).optional() }).strict();

export function createAiGateway({ env = process.env, generate = googleContent, now = Date.now } = {}) {
  if (!/^[a-f0-9]{64}$/.test(env.SABI_AI_GATEWAY_SECRET || '') || env.SABI_AI_PROVIDER !== 'vertex' || env.SABI_AI_AUTH_MODE !== 'adc') throw new Error('AI_GATEWAY_CONFIGURATION_INVALID');
  const app = express(); app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'sabi-ai-runtime', release: env.K_REVISION || 'local' }));
  app.post('/v1/generate', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const timestamp = req.get('x-sabi-timestamp') || ''; const signature = req.get('x-sabi-signature') || '';
    if (!Buffer.isBuffer(req.body) || !/^\d{13}$/.test(timestamp) || Math.abs(now() - Number(timestamp)) > 60000 || !/^[a-f0-9]{64}$/.test(signature)) return res.status(401).json({ code: 'UNAUTHORIZED' });
    const expected = gatewaySignature(env.SABI_AI_GATEWAY_SECRET, timestamp, req.body);
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) return res.status(401).json({ code: 'UNAUTHORIZED' });
    let parsed; try { parsed = schema.safeParse(JSON.parse(req.body.toString('utf8'))); } catch { return res.status(422).json({ code: 'INVALID_REQUEST' }); }
    if (!parsed.success) return res.status(422).json({ code: 'INVALID_REQUEST' });
    const controller = new globalThis.AbortController(); const close = () => { if (!res.writableEnded) controller.abort(); }; res.on('close', close);
    try { return res.json(await generate(parsed.data.payload, { maxCharacters: parsed.data.maxCharacters, signal: controller.signal, ...(parsed.data.tokenBudget !== undefined ? { tokenBudget: parsed.data.tokenBudget } : {}) })); }
    catch (error) { return res.status(error?.code === 'AI_TOKEN_QUOTA' ? 429 : 503).json({ code: error?.code === 'AI_TOKEN_QUOTA' ? 'AI_TOKEN_QUOTA' : 'AI_PROVIDER_UNAVAILABLE', aiProviderDispatched: error?.aiProviderDispatched !== false, ...(error?.usage ? { usage: { inputTokens: error.usage.inputTokens, outputTokens: error.usage.outputTokens, totalTokens: error.usage.totalTokens } } : {}) }); }
    finally { res.off('close', close); }
  });
  app.use((_error, _req, res, next) => res.status(400).json({ code: 'INVALID_REQUEST' }));
  return app;
}
