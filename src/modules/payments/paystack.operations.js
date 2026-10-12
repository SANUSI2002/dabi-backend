const endpoint = 'https://api.paystack.co';
export const operationsConfigured = () => Boolean(process.env.PAYSTACK_SECRET_KEY?.trim());
export async function providerRequest(path, { method = 'GET', body } = {}, fetcher = globalThis.fetch) {
  if (!operationsConfigured()) throw Object.assign(new Error('Payment provider is not configured.'), { code: 'PROVIDER_NOT_CONFIGURED', status: 503 });
  let response;
  try {
    response = await fetcher(`${endpoint}${path}`, { method, redirect: 'error', signal: globalThis.AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch { throw Object.assign(new Error('The provider could not be reached. Reconcile before retrying.'), { code: 'PROVIDER_UNAVAILABLE', status: 503, uncertain: method !== 'GET' }); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.status !== true || !result.data) throw Object.assign(new Error('The payment provider could not complete this action.'), { code: response.status === 404 ? 'PROVIDER_REFERENCE_NOT_FOUND' : 'PROVIDER_REJECTED', status: 503, uncertain: response.status >= 500 || response.status === 429 });
  return result.data;
}
export const bankList = () => providerRequest('/bank?country=nigeria&currency=NGN&perPage=100');
export const resolveBank = (accountNumber, bankCode) => providerRequest(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
export const createRecipient = ({ name, accountNumber, bankCode }) => providerRequest('/transferrecipient', { method: 'POST', body: { type: 'nuban', currency: 'NGN', name, account_number: accountNumber, bank_code: bankCode } });
export const sendTransfer = ({ amountMinor, recipientCode, reference }) => providerRequest('/transfer', { method: 'POST', body: { source: 'balance', currency: 'NGN', amount: amountMinor, recipient: recipientCode, reference, reason: 'Sabi rider earnings payout' } });
export const verifyTransfer = (reference) => providerRequest(`/transfer/verify/${encodeURIComponent(reference)}`);
export const finalizeTransfer = ({ transferCode, otp }) => providerRequest('/transfer/finalize_transfer', { method: 'POST', body: { transfer_code: transferCode, otp } });
export const verifyCharge = (reference) => providerRequest(`/transaction/verify/${encodeURIComponent(reference)}`);
export const initializeCharge = ({ email, amountMinor, reference, callbackUrl }) => providerRequest('/transaction/initialize', { method: 'POST', body: { email, amount: amountMinor, currency: 'NGN', reference, callback_url: callbackUrl } });
