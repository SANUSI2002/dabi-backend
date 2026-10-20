import { GoogleAuth } from 'google-auth-library';
import { setTimeout, clearTimeout } from 'node:timers';
import { aiError } from './ai.config.js';

let auth;
// On Cloud Run, ADC uses the attached service identity: no downloaded JSON key.
// Local development uses separately authorised ADC, never browser cookies or copied tokens.
export async function googleAuthorization({ signal } = {}) {
  if (signal?.aborted) throw aiError(503, 'AI_CANCELLED', 'The AI request was cancelled.');
  auth ??= new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  let timer; let onAbort;
  try {
    const token = await Promise.race([
      auth.getAccessToken(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('AUTH_TIMEOUT')), 12000); timer.unref(); }),
      new Promise((_, reject) => { onAbort = () => reject(new Error('AUTH_CANCELLED')); signal?.addEventListener('abort', onAbort, { once: true }); }),
    ]);
    if (typeof token !== 'string' || !token) throw new Error('AUTH_UNAVAILABLE');
    return { Authorization: `Bearer ${token}` };
  } catch {
    throw aiError(503, signal?.aborted ? 'AI_CANCELLED' : 'AI_PROVIDER_UNAVAILABLE', 'Sabi could not authenticate its AI provider.');
  } finally { clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort); }
}
