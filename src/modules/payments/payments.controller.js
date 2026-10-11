import { createHash } from 'node:crypto';
import prisma from '../../config/db.js';
import { applyRefundWebhook } from '../command-centre/finance.service.js';
import * as s from './payments.service.js';import * as adapter from './paystack.adapter.js';
const fail=(e,res,next)=>{if(e.code==='FORBIDDEN')return res.status(403).json({status:'error',message:'Not authorized'});if(e.code==='NOT_FOUND')return res.status(404).json({status:'error',message:'Order not found'});if(e.code==='CONFIG')return res.status(503).json({status:'error',code:'PAYMENT_PROVIDER_NOT_CONFIGURED',message:'Payment provider is unavailable'});if(e.code)return res.status(400).json({status:'error',message:'Payment cannot be processed'});return next(e)};
export const initialize=async(req,res,next)=>{try{const x=await s.initialize(req.user.id,req.params.id,req.body.idempotencyKey);res.status(x.idempotent?200:201).json({status:'success',data:x.payment})}catch(e){fail(e,res,next)}};
export const status=async(req,res,next)=>{try{res.json({status:'success',data:await s.status(req.user.id,req.params.id)})}catch(e){fail(e,res,next)}};
// Every delivery is logged (event type, reference, outcome — never the payload) for webhook health
// and reconciliation in the Command Centre. Logging must never change the response Paystack gets.
const receipt = async (data) => {
  try { await prisma.paymentWebhookReceipt.create({ data: { provider: 'PAYSTACK', ...data } }); } catch { /* best effort */ }
};
export const webhook = async (req, res) => {
  const raw = req.body;
  if (!adapter.validSignature(raw, req.get('x-paystack-signature'))) {
    await receipt({ outcome: 'REJECTED_SIGNATURE' });
    return res.status(401).json({ status: 'error', message: 'Invalid webhook signature' });
  }
  const eventKey = createHash('sha256').update(raw).digest('hex');
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch {
    await receipt({ eventKey, outcome: 'REJECTED_INVALID', detail: 'Body is not JSON' });
    return res.sendStatus(200);
  }
  const eventType = typeof event?.event === 'string' ? event.event.slice(0, 64) : null;
  const refundEvent = eventType?.startsWith('refund.');
  const reference = String((refundEvent ? event?.data?.transaction_reference ?? event?.data?.transaction?.reference : event?.data?.reference) ?? '').slice(0, 120) || null;
  try {
    const result = refundEvent ? await applyRefundWebhook(event) : await s.webhook(raw, event);
    await receipt({ eventType, reference, eventKey, outcome: result?.duplicate ? 'DUPLICATE' : result?.ignored ? 'IGNORED' : 'APPLIED', detail: result?.detail ? String(result.detail).slice(0, 200) : null });
  } catch (error) {
    await receipt({ eventType, reference, eventKey, outcome: error?.code === 'INVALID' ? 'REJECTED_INVALID' : 'ERROR', detail: String(error?.code ?? 'Processing failed').slice(0, 200) });
  }
  return res.sendStatus(200);
};
