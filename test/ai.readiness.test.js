import { describe, expect, it, vi } from 'vitest';
import { aiRuntimeConfiguration, checkAiProviders } from '../src/modules/ai/ai.readiness.js';
const env = { SABI_AI_ENABLED: 'true', SABI_AI_GOOGLE_PROCESSING_APPROVED: 'true', SABI_AI_GOOGLE_API_KEY: 'synthetic-google-secret', SABI_AI_MODEL: 'gemini-synthetic',
  SABI_AI_PROVIDER: 'vertex', SABI_AI_GOOGLE_PROJECT_ID: 'synthetic-project', TYPESAFE_API_KEY: 'synthetic-jev-secret', JEV_SMOKE_MODEL: 'jev-1.13.0', JEV_ENABLED: 'true', JEV_PROCESSING_APPROVED: 'true' };
describe('AI runtime readiness distinguishes configuration, providers and end-to-end delivery', () => {
  it('never serializes credentials and never treats configuration as provider verification', () => {
    const result = aiRuntimeConfiguration(env); const text = JSON.stringify(result);
    expect(text).not.toContain(env.SABI_AI_GOOGLE_API_KEY); expect(text).not.toContain(env.TYPESAFE_API_KEY);
    expect(result.google).toMatchObject({ configurationReady: true, providerVerified: false }); expect(result.jev.providerVerified).toBe(false);
  });
  it('does not call a provider unless execution was explicitly requested', async () => {
    const google = vi.fn(); const jev = vi.fn(); const result = await checkAiProviders({ env, google, jev });
    expect(google).not.toHaveBeenCalled(); expect(jev).not.toHaveBeenCalled(); expect(result.endToEndVerified).toBe(false);
  });
  it('runs only fixed synthetic fixtures and reports each provider independently', async () => {
    const google = vi.fn(async () => ({ text: 'SABI_OK', usage: { inputTokens: 5, outputTokens: 3 } }));
    const jev = vi.fn(async () => ({ model: env.JEV_SMOKE_MODEL, answers: { sky_color: { choice: 'blue' } }, usage: { inputTokens: 8, outputTokens: 3 } }));
    const result = await checkAiProviders({ execute: true, env, google, jev });
    expect(result.checks.google.status).toBe('VERIFIED'); expect(result.checks.jev.status).toBe('VERIFIED'); expect(result.endToEndVerified).toBe(false);
    expect(google.mock.calls[0][0].contents[0].parts[0].text).toContain('No personal or medical information');
    expect(jev.mock.calls[0][0].state).toEqual({ sentence: 'The sky is blue.' });
  });
  it('redacts failures and continues the other probe', async () => {
    const google = vi.fn(async () => { throw Object.assign(new Error('secret provider error'), { code: 'AI_PROVIDER_UNAVAILABLE' }); });
    const jev = vi.fn(async () => { throw Object.assign(new Error('private body'), { code: 20 }); });
    const result = await checkAiProviders({ execute: true, env, google, jev }); const text = JSON.stringify(result);
    expect(result.checks.google.code).toBe('AI_PROVIDER_UNAVAILABLE'); expect(result.checks.jev.code).toBe('JEV_CHECK_FAILED');
    expect(text).not.toContain('secret provider error'); expect(text).not.toContain('private body');
  });
  it('does not guess an absent model or silently select a clinical JEV alias', async () => {
    const google = vi.fn(); const jev = vi.fn();
    const result = await checkAiProviders({ execute: true, env: { ...env, SABI_AI_MODEL: '', JEV_SMOKE_MODEL: 'jev-latest' }, google, jev });
    expect(result.checks.google.code).toBe('AI_CONFIGURATION_INCOMPLETE'); expect(result.checks.jev.code).toBe('JEV_SMOKE_MODEL_REQUIRED');
    expect(google).not.toHaveBeenCalled(); expect(jev).not.toHaveBeenCalled();
  });
  it('handles an empty runtime without pretending an AI key or attached identity is present', () => {
    const result = aiRuntimeConfiguration({}); expect(result.google.configurationReady).toBe(false); expect(result.google.credentialConfigured).toBe(false); expect(result.jev.credentialConfigured).toBe(false);
  });
  it('does not report whitespace credentials as usable generation configuration', () => {
    const result = aiRuntimeConfiguration({ ...env, SABI_AI_GOOGLE_API_KEY: '  ', TYPESAFE_API_KEY: '  ' });
    expect(result.google.configurationReady).toBe(false); expect(result.google.credentialConfigured).toBe(false); expect(result.jev.credentialConfigured).toBe(false);
  });
});
