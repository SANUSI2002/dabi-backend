// Sends WhatsApp messages. Two providers behind one interface:
//   cloud     — Meta's WhatsApp Cloud API (production). Needs WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.
//   simulator — keeps messages in memory for local development and tests; nothing leaves the machine.
// WHATSAPP_PROVIDER unset means WhatsApp is off and Sabi offers in-app notifications only.
// Errors are WhatsAppSendError with `transient` saying whether a retry may succeed.
import { randomUUID } from 'node:crypto';

export class WhatsAppSendError extends Error {
  constructor(message, { transient, code } = {}) {
    super(message);
    this.name = 'WhatsAppSendError';
    this.transient = Boolean(transient);
    this.code = code ?? null;
  }
}

export const whatsappConfig = () => ({
  provider: process.env.WHATSAPP_PROVIDER || '',
  apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
  appSecret: process.env.WHATSAPP_APP_SECRET || '',
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
  language: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en',
  templates: {
    verification: process.env.WHATSAPP_TEMPLATE_VERIFICATION || 'sabi_verification_code',
    reminder: process.env.WHATSAPP_TEMPLATE_REMINDER || 'sabi_medication_reminder',
    update: process.env.WHATSAPP_TEMPLATE_UPDATE || 'sabi_update',
  },
});

export const simulatorAllowed = () => whatsappConfig().provider === 'simulator' && process.env.NODE_ENV !== 'production';

// Meta error codes that will not succeed on retry (number not on WhatsApp, template problems,
// outside the 24-hour window, recipient blocked us…). Rate limits and server errors are retried.
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131048, 131056]);
const cloudFailure = (status, body) => {
  const code = body?.error?.code ?? null;
  const transient = status >= 500 || status === 429 || RATE_LIMIT_CODES.has(code);
  return new WhatsAppSendError(`WhatsApp rejected the message (${code ?? status})`, { transient, code: code ?? status });
};

function cloudProvider(config) {
  const post = async (payload) => {
    let response;
    try {
      response = await globalThis.fetch(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
        signal: globalThis.AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new WhatsAppSendError('Could not reach WhatsApp', { transient: true, code: error?.name || 'NETWORK' });
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw cloudFailure(response.status, body);
    const messageId = body?.messages?.[0]?.id;
    if (!messageId) throw new WhatsAppSendError('WhatsApp did not return a message id', { transient: true, code: 'NO_ID' });
    return { messageId };
  };
  return {
    name: 'cloud',
    ready: Boolean(config.accessToken && config.phoneNumberId),
    sendTemplate: (to, template) => post({ to: to.replace(/^\+/, ''), type: 'template', template: { name: template.name, language: { code: config.language }, components: template.components } }),
    sendText: (to, text) => post({ to: to.replace(/^\+/, ''), type: 'text', text: { body: text, preview_url: false } }),
  };
}

// ---- simulator ----
const simulated = { messages: [], failures: [] };
export const simulator = {
  /** Messages "sent", newest last. */
  messages: (phone) => simulated.messages.filter((m) => !phone || m.to === phone),
  /** Makes the next send fail, e.g. { transient: true } for a temporary outage. */
  failNext: (failure = { transient: true }) => { simulated.failures.push(failure); },
  reset: () => { simulated.messages.length = 0; simulated.failures.length = 0; },
};
function simulatorProvider() {
  const record = (to, message) => {
    const failure = simulated.failures.shift();
    if (failure) throw new WhatsAppSendError('Simulated WhatsApp failure', { transient: failure.transient, code: failure.code ?? 'SIMULATED' });
    const messageId = `wamid.SIM${randomUUID().replace(/-/g, '')}`;
    simulated.messages.push({ id: messageId, to, at: new Date().toISOString(), ...message });
    if (simulated.messages.length > 500) simulated.messages.shift();
    return { messageId };
  };
  return {
    name: 'simulator',
    ready: true,
    sendTemplate: async (to, template) => record(to, { type: 'template', template: template.name, text: template.preview, buttons: template.buttons ?? [] }),
    sendText: async (to, text) => record(to, { type: 'text', text, buttons: [] }),
  };
}

/** The configured provider, or null when WhatsApp is off. Read at call time so settings can change. */
export function whatsappProvider() {
  const config = whatsappConfig();
  if (config.provider === 'cloud') {
    const provider = cloudProvider(config);
    return provider.ready ? provider : null;
  }
  if (simulatorAllowed()) return simulatorProvider();
  return null;
}
