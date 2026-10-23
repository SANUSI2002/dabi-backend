import { URL } from 'node:url';
export const AI_CONSENT_VERSION = 'sabi-ai-conversation-v1';
export const AI_DOCUMENT_CONSENT_VERSION = 'sabi-ai-document-v1';
export const aiConfig = (env = process.env) => ({
  enabled: env.SABI_AI_ENABLED === 'true',
  processingApproved: env.SABI_AI_GOOGLE_PROCESSING_APPROVED === 'true',
  apiKey: env.SABI_AI_GOOGLE_API_KEY || '',
  model: env.SABI_AI_MODEL || '',
  projectId: env.SABI_AI_GOOGLE_PROJECT_ID || '',
  provider: env.SABI_AI_PROVIDER || 'gemini',
  authMode: env.SABI_AI_AUTH_MODE || 'api-key',
  gatewayUrl: env.SABI_AI_GATEWAY_URL || '',
  gatewaySecret: env.SABI_AI_GATEWAY_SECRET || '',
});
export const aiAvailable = (env = process.env) => {
  const c = aiConfig(env);
  if (c.provider === 'gateway') {
    let validUrl = false;
    try { const url = new URL(c.gatewayUrl); validUrl = url.protocol === 'https:' && url.hostname.endsWith('.run.app') && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; } catch { /* unavailable */ }
    return Boolean(c.enabled && c.processingApproved && c.authMode === 'gateway' && validUrl && /^[a-f0-9]{64}$/.test(c.gatewaySecret) && /^gemini-[a-z0-9._-]{1,100}$/.test(c.model));
  }
  return Boolean(c.enabled && c.processingApproved && (c.authMode === 'api-key' ? c.apiKey && !/\s/.test(c.apiKey) : c.authMode === 'adc' && c.provider === 'vertex') && /^[a-zA-Z0-9._-]{1,120}$/.test(c.model) &&
    ['gemini', 'vertex'].includes(c.provider) && (c.provider !== 'vertex' || /^[a-z0-9-]+$/.test(c.projectId)));
};
export const aiError = (status, code, message) => Object.assign(new Error(message), { status, code });
export const requireAiAvailable = () => {
  if (!aiAvailable()) throw aiError(503, 'AI_UNAVAILABLE', 'Sabi AI is not available yet. Your normal Sabi services remain available.');
};
export const aiDocumentsAvailable = () => aiAvailable() && process.env.SABI_AI_DOCUMENT_PROCESSING_APPROVED === 'true';
