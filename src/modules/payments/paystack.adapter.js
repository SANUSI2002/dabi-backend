import { createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

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
