import { createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { clearTimeout, setTimeout } from 'node:timers';

const key = () => process.env.PAYSTACK_SECRET_KEY;
export const configured = () => Boolean(key());
export const validSignature = (rawBody, signature) => {
  if (!key() || !signature || !Buffer.isBuffer(rawBody)) return false;
  const expected = createHmac('sha512', key()).update(rawBody).digest('hex');
  const supplied = Buffer.from(signature, 'utf8');
  const signed = Buffer.from(expected, 'utf8');
  return supplied.length === signed.length && timingSafeEqual(supplied, signed);
};
export const initialize = async ({ email, amountMinor, reference }) => {
  const response = await globalThis.fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST', headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, amount: String(amountMinor), currency: 'NGN', reference, ...(process.env.PAYSTACK_CALLBACK_URL ? { callback_url: process.env.PAYSTACK_CALLBACK_URL } : {}) }),
  });
  const body = await response.json();
  if (!response.ok || !body.status || !body.data?.authorization_url || !body.data?.reference) throw Object.assign(new Error('PROVIDER'), { code: 'PROVIDER' });
  return { reference: body.data.reference, authorizationUrl: body.data.authorization_url, accessCode: body.data.access_code ?? null };
};

/**
 * Asks Paystack to refund (part of) a successful transaction. Paystack processes refunds
 * asynchronously: the response only says the refund was accepted (usually "pending"); completion
 * arrives later as a refund.processed / refund.failed webhook.
 * @returns {{ reference: string, status: string }} Paystack's refund id and its current status.
 */
export const refund = async ({ transactionReference, amountMinor }) => {
  if (!key()) throw Object.assign(new Error('PROVIDER_NOT_CONFIGURED'), { code: 'PROVIDER_NOT_CONFIGURED' });
  const controller = new globalThis.AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await globalThis.fetch('https://api.paystack.co/refund', {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: transactionReference, amount: amountMinor, currency: 'NGN' }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.status || body.data?.id === undefined) {
      throw Object.assign(new Error('PROVIDER'), { code: 'PROVIDER', providerMessage: String(body.message ?? `HTTP ${response.status}`).slice(0, 200) });
    }
    return { reference: String(body.data.id), status: String(body.data.status ?? 'pending') };
  } catch (error) {
    if (error.code) throw error;
    throw Object.assign(new Error('PROVIDER'), { code: 'PROVIDER', providerMessage: error.name === 'AbortError' ? 'Timed out waiting for Paystack' : 'Could not reach Paystack', unknownOutcome: true });
  } finally {
    clearTimeout(timer);
  }
};
