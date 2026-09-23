import bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const model = vi.hoisted(() => ({
  createPatient: vi.fn(), findUserByEmail: vi.fn(), createEmailVerificationToken: vi.fn(),
  revokeEmailVerificationToken: vi.fn(), revokeOtherEmailVerificationTokens: vi.fn(),
  latestEmailVerificationToken: vi.fn(), confirmEmailVerificationToken: vi.fn(),
}));
const mail = vi.hoisted(() => ({
  verificationEmailConfigured: vi.fn(), verificationEmailAllowedFor: vi.fn(), sendEmailVerificationEmail: vi.fn(),
}));
vi.mock('../src/modules/auth/auth.model.js', () => model);
vi.mock('../src/modules/auth/auth.email.js', () => mail);
const { registerPatient, login, requestEmailVerification, confirmEmailVerification } = await import('../src/modules/auth/auth.controller.js');

const response = () => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};
const patient = (password) => ({ id: '11111111-1111-4111-8111-111111111111', email: 'patient@example.test', password, accountStatus: 'PENDING', emailVerifiedAt: null, roles: [{ role: 'PATIENT' }], profile: {} });
const originalPortal = process.env.PATIENT_PORTAL_URL;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PATIENT_PORTAL_URL = 'https://telemedicine.sabihealth.org';
  mail.verificationEmailConfigured.mockReturnValue(true);
  mail.verificationEmailAllowedFor.mockReturnValue(true);
  mail.sendEmailVerificationEmail.mockResolvedValue({ delivered: true });
  model.createPatient.mockResolvedValue(patient('hash'));
  model.createEmailVerificationToken.mockResolvedValue({ id: 'token-1' });
  model.revokeOtherEmailVerificationTokens.mockResolvedValue({ count: 0 });
});
afterEach(() => {
  if (originalPortal === undefined) delete process.env.PATIENT_PORTAL_URL;
  else process.env.PATIENT_PORTAL_URL = originalPortal;
});

describe('patient email verification', () => {
  it('registers pending and sends a hashed, expiring, one-use link', async () => {
    const res = response();
    await registerPatient({ body: { email: 'patient@example.test' } }, res, vi.fn());
    expect(res.statusCode).toBe(201);
    expect(res.body.emailSent).toBe(true);
    expect(res.body.user).not.toHaveProperty('password');
    const [, storedHash, expiresAt] = model.createEmailVerificationToken.mock.calls[0];
    const url = mail.sendEmailVerificationEmail.mock.calls[0][0].verificationUrl;
    const rawToken = url.split('#')[1];
    expect(url).toMatch(/^https:\/\/telemedicine\.sabihealth\.org\/verify-email\/11111111-1111-4111-8111-111111111111#[a-f0-9]{64}$/);
    expect(storedHash).not.toBe(rawToken);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
  });

  it('blocks a pending patient only after the password is valid', async () => {
    const password = await bcrypt.hash('CorrectPassword123!', 4);
    model.findUserByEmail.mockResolvedValue(patient(password));
    const invalid = response();
    await login({ body: { email: 'patient@example.test', password: 'wrong' } }, invalid, vi.fn());
    expect(invalid.statusCode).toBe(401);
    const pending = response();
    await login({ body: { email: 'patient@example.test', password: 'CorrectPassword123!' } }, pending, vi.fn());
    expect(pending.statusCode).toBe(403);
    expect(pending.body.error.code).toBe('EMAIL_VERIFICATION_REQUIRED');
  });

  it('does not reveal whether a pending account exists when resending', async () => {
    model.findUserByEmail.mockResolvedValue(null);
    const res = response();
    await requestEmailVerification({ body: { email: 'missing@example.test' } }, res, vi.fn());
    expect(res.statusCode).toBe(202);
    expect(mail.sendEmailVerificationEmail).not.toHaveBeenCalled();
  });

  it('accepts only a valid unused verification token', async () => {
    const req = { body: { uid: patient('hash').id, token: 'a'.repeat(64) } };
    model.confirmEmailVerificationToken.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const invalid = response();
    await confirmEmailVerification(req, invalid, vi.fn());
    expect(invalid.statusCode).toBe(400);
    const valid = response();
    await confirmEmailVerification(req, valid, vi.fn());
    expect(valid.statusCode).toBe(200);
    expect(model.confirmEmailVerificationToken.mock.calls[0][1]).not.toBe(req.body.token);
  });
});
