import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { handleWebhook, signatureValid } from './whatsapp.webhook.js';
import { normalizePhone } from './whatsapp.messages.js';
import { simulator, simulatorAllowed, whatsappConfig } from './whatsapp.provider.js';

// Meta's webhook. Mounted before the JSON parser: the signature covers the raw body.
export const whatsappWebhookRoutes = express.Router();

// Subscription handshake when the webhook is set up in the Meta app dashboard.
whatsappWebhookRoutes.get('/', (req, res) => {
  const { verifyToken } = whatsappConfig();
  if (verifyToken && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) {
    return res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
  }
  return res.sendStatus(403);
});

whatsappWebhookRoutes.post('/', express.raw({ type: '*/*', limit: '1mb' }), async (req, res, next) => {
  if (!signatureValid(req.body, req.get('x-hub-signature-256'))) return res.sendStatus(401);
  let body;
  try { body = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
  try {
    const { failed } = await handleWebhook(body);
    return res.sendStatus(failed ? 500 : 200);
  } catch (error) {
    return next(error);
  }
});

// Local WhatsApp simulator (WHATSAPP_PROVIDER=simulator, never in production): see what Sabi "sent"
// and play the patient tapping a button or writing back. Replies go through the same handler as
// Meta's webhook, after the signature step.
export const whatsappSimulatorRoutes = express.Router();
whatsappSimulatorRoutes.use((req, res, next) => (simulatorAllowed() ? next() : res.sendStatus(404)));

whatsappSimulatorRoutes.get('/messages', (req, res) => {
  const phone = req.query.phone ? normalizePhone(req.query.phone) : null;
  res.set('Cache-Control', 'no-store').json({ status: 'success', data: simulator.messages(phone) });
});

const replySchema = z.object({ from: z.string().min(6).max(24), payload: z.string().max(200).optional(), text: z.string().max(1000).optional() }).strict();
whatsappSimulatorRoutes.post('/reply', express.json(), async (req, res, next) => {
  const parsed = replySchema.safeParse(req.body);
  const from = parsed.success ? normalizePhone(parsed.data.from) : null;
  if (!from) return res.status(400).json({ status: 'error', message: 'Give the sender number and a button payload or text.' });
  const id = `wamid.SIMIN${randomUUID().replace(/-/g, '')}`;
  const message = parsed.data.payload
    ? { id, from: from.slice(1), type: 'button', button: { payload: parsed.data.payload, text: parsed.data.payload.split(':')[0] } }
    : { id, from: from.slice(1), type: 'text', text: { body: parsed.data.text ?? '' } };
  try {
    await handleWebhook({ entry: [{ changes: [{ value: { messages: [message] } }] }] });
    return res.json({ status: 'success', data: { replies: simulator.messages(from).filter((m) => m.type === 'text').slice(-1) } });
  } catch (error) {
    return next(error);
  }
});

whatsappSimulatorRoutes.post('/status', express.json(), async (req, res, next) => {
  const { messageId, status } = req.body ?? {};
  if (!messageId || !['sent', 'delivered', 'read', 'failed'].includes(status)) return res.status(400).json({ status: 'error', message: 'Give messageId and status.' });
  try {
    await handleWebhook({ entry: [{ changes: [{ value: { statuses: [{ id: messageId, status, timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] });
    return res.json({ status: 'success' });
  } catch (error) {
    return next(error);
  }
});
