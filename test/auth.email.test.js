import { afterEach, describe, expect, it, vi } from 'vitest';
import { passwordResetEmailAllowedFor, passwordResetEmailConfigured, sendPasswordResetEmail } from '../src/modules/auth/auth.email.js';

const originalKey = process.env.RESEND_API_KEY;
const originalFrom = process.env.PASSWORD_RESET_EMAIL_FROM;
const originalTestRecipient = process.env.RESEND_TEST_RECIPIENT;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalKey;
  if (originalFrom === undefined) delete process.env.PASSWORD_RESET_EMAIL_FROM;
  else process.env.PASSWORD_RESET_EMAIL_FROM = originalFrom;
  if (originalTestRecipient === undefined) delete process.env.RESEND_TEST_RECIPIENT;
  else process.env.RESEND_TEST_RECIPIENT = originalTestRecipient;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('password reset email', () => {
  it('refuses missing or placeholder credentials', async () => {
    process.env.RESEND_API_KEY = '';
    process.env.PASSWORD_RESET_EMAIL_FROM = 'no-reply@example.com';
    globalThis.fetch = vi.fn();
    expect(passwordResetEmailConfigured()).toBe(false);
    expect(await sendPasswordResetEmail({ email: 'a@test.com', resetUrl: 'https://test/reset' })).toEqual({ delivered: false });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('sends a single-use reset link through the configured provider', async () => {
    process.env.RESEND_API_KEY = 'test-only-key';
    process.env.PASSWORD_RESET_EMAIL_FROM = 'Sabi ID <identity@sabi.test>';
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    expect(passwordResetEmailConfigured()).toBe(true);
    expect(await sendPasswordResetEmail({ email: 'a@test.com', resetUrl: 'https://sabi.test/reset-password/u/t' })).toEqual({ delivered: true });
    const [url, options] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(options.headers.Authorization).toBe('Bearer test-only-key');
    expect(JSON.parse(options.body)).toMatchObject({ from: 'Sabi ID <identity@sabi.test>', to: ['a@test.com'] });
  });

  it('does not log reset links on a provider failure', async () => {
    process.env.RESEND_API_KEY = 'test-only-key';
    process.env.PASSWORD_RESET_EMAIL_FROM = 'identity@sabi.test';
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendPasswordResetEmail({ email: 'a@test.com', resetUrl: 'https://sabi.test/private-token' })).toEqual({ delivered: false });
    expect(error.mock.calls.flat().join(' ')).not.toContain('private-token');
  });

  it('requires an exact self-only recipient for the onboarding sender', () => {
    process.env.RESEND_API_KEY = 'test-only-key';
    process.env.PASSWORD_RESET_EMAIL_FROM = 'onboarding@resend.dev';
    delete process.env.RESEND_TEST_RECIPIENT;
    expect(passwordResetEmailConfigured()).toBe(false);
    process.env.RESEND_TEST_RECIPIENT = 'owner@test.com';
    expect(passwordResetEmailConfigured()).toBe(true);
    expect(passwordResetEmailAllowedFor(' OWNER@test.com ')).toBe(true);
    expect(passwordResetEmailAllowedFor('other@test.com')).toBe(false);
  });
});
