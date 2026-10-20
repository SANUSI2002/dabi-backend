export const AI_CONSENT_VERSION = 'sabi-ai-conversation-v1';
export const AI_DOCUMENT_CONSENT_VERSION = 'sabi-ai-document-v1';
const bounded = (key, fallback, max) => {
  const value = Number(process.env[key]);
  return Number.isSafeInteger(value) && value > 0 && value <= max ? value : fallback;
};
export const aiLimits = () => ({
  userDailyRuns: bounded('SABI_AI_USER_DAILY_RUNS', 10, 1000),
  globalDailyRuns: bounded('SABI_AI_GLOBAL_DAILY_RUNS', 30, 10000),
  globalTotalRuns: bounded('SABI_AI_GLOBAL_TOTAL_RUNS', 1000, 100000),
});
export const aiConfig = () => ({
  enabled: process.env.SABI_AI_ENABLED === 'true',
  processingApproved: process.env.SABI_AI_GOOGLE_PROCESSING_APPROVED === 'true',
  apiKey: process.env.SABI_AI_GOOGLE_API_KEY || '',
  model: process.env.SABI_AI_MODEL || '',
  projectId: process.env.SABI_AI_GOOGLE_PROJECT_ID || '',
  provider: process.env.SABI_AI_PROVIDER || 'gemini',
  authMode: process.env.SABI_AI_AUTH_MODE || 'api-key',
});
export const aiAvailable = () => {
  const c = aiConfig();
  return Boolean(c.enabled && c.processingApproved && (c.authMode === 'api-key' ? c.apiKey : c.authMode === 'adc' && c.provider === 'vertex') && /^[a-zA-Z0-9._-]{1,120}$/.test(c.model) &&
    ['gemini', 'vertex'].includes(c.provider) && (c.provider !== 'vertex' || /^[a-z0-9-]+$/.test(c.projectId)));
};
export const aiError = (status, code, message) => Object.assign(new Error(message), { status, code });
export const requireAiAvailable = () => {
  if (!aiAvailable()) throw aiError(503, 'AI_UNAVAILABLE', 'Sabi AI is not available yet. Your normal Sabi services remain available.');
};
export const aiDocumentsAvailable = () => aiAvailable() && process.env.SABI_AI_DOCUMENT_PROCESSING_APPROVED === 'true';
