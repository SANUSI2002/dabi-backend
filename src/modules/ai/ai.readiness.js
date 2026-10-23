import { aiAvailable, aiConfig } from './ai.config.js';
import { googleContent } from './ai.provider.js';
import { evaluateJev } from './jev/jev.provider.js';

/** Metadata only. Configuration is NOT proof that IAM, model access or a provider works. */
export function aiRuntimeConfiguration(env = process.env) {
  const c = aiConfig(env);
  return {
    google: {
      provider: ['gemini', 'vertex', 'gateway'].includes(c.provider) ? c.provider : null,
      authMode: ['adc', 'api-key', 'gateway'].includes(c.authMode) ? c.authMode : null,
      model: /^gemini-[a-z0-9._-]{1,100}$/.test(c.model) ? c.model : null,
      projectId: /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(c.projectId) ? c.projectId : null,
      credentialConfigured: c.authMode === 'gateway' ? /^[a-f0-9]{64}$/.test(c.gatewaySecret) : c.authMode === 'adc' ? c.provider === 'vertex' : Boolean(c.apiKey && !/\s/.test(c.apiKey)),
      configurationReady: aiAvailable(env), enabled: c.enabled, processingApproved: c.processingApproved,
      providerVerified: false,
    },
    jev: { credentialConfigured: Boolean(env.TYPESAFE_API_KEY && !/\s/.test(env.TYPESAFE_API_KEY)),
      enabled: env.JEV_ENABLED === 'true', processingApproved: env.JEV_PROCESSING_APPROVED === 'true',
      tenantPolicyRequired: true, providerVerified: false },
    checksPerformed: 'CONFIGURATION_ONLY',
  };
}
const failure = (code) => ({ status: 'NOT_VERIFIED', code });
const safeCode = (error, prefix) => typeof error?.code === 'string' && new RegExp(`^${prefix}_[A-Z_]{1,80}$`).test(error.code) ? error.code : `${prefix}_CHECK_FAILED`;

/** Explicit synthetic provider checks only. No DB, user session, chart or document is read. */
export async function checkAiProviders({ execute = false, env = process.env, google = googleContent, jev = evaluateJev } = {}) {
  const configuration = aiRuntimeConfiguration(env);
  const checks = { google: { status: 'NOT_RUN' }, jev: { status: 'NOT_RUN' } };
  if (!execute) return { configuration, checks, endToEndVerified: false };
  const c = aiConfig(env);
  if (!configuration.google.credentialConfigured || !configuration.google.model || (c.provider === 'vertex' && !configuration.google.projectId)) checks.google = failure('AI_CONFIGURATION_INCOMPLETE');
  else {
    try {
      const response = await google({ systemInstruction: { parts: [{ text: 'This is a synthetic connectivity check. Reply with exactly SABI_OK and nothing else.' }] },
        contents: [{ role: 'user', parts: [{ text: 'Connectivity check. No personal or medical information is included.' }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 32 },
      }, { maxCharacters: 256 });
      checks.google = response.text.trim() === 'SABI_OK' ? { status: 'VERIFIED', model: c.model, usage: response.usage } : failure('AI_CHECK_RESPONSE_INVALID');
    } catch (error) { checks.google = failure(safeCode(error, 'AI')); }
  }
  if (!configuration.jev.credentialConfigured) checks.jev = failure('JEV_NOT_CONFIGURED');
  else if (!/^jev-\d+\.\d+\.\d+$/.test(env.JEV_SMOKE_MODEL || '')) checks.jev = failure('JEV_SMOKE_MODEL_REQUIRED');
  else {
    try {
      const response = await jev({ model: env.JEV_SMOKE_MODEL, state: { sentence: 'The sky is blue.' }, questions: { sky_color: {
        type: 'choice', instructions: 'Choose the colour explicitly stated for the sky. Do not infer another colour.', criteria: { blue: 'Blue is stated.', red: 'Red is stated.' },
      } } });
      checks.jev = response.answers.sky_color.choice === 'blue' ? { status: 'VERIFIED', model: response.model, usage: response.usage } : failure('JEV_CHECK_RESPONSE_INVALID');
    } catch (error) { checks.jev = failure(safeCode(error, 'JEV')); }
  }
  // Even successful provider probes do not verify patient auth, queue processing, policy or UI.
  return { configuration, checks, endToEndVerified: false };
}
