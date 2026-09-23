import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = { method: null, codes: [], challenge: null };
const prisma = {
  user: { findUnique: vi.fn() },
  mfaTotp: {
    findUnique: vi.fn(async () => state.method),
    upsert: vi.fn(async ({ create, update }) => { state.method = { ...(state.method || create), ...update, updatedAt: new Date() }; return state.method; }),
    updateMany: vi.fn(async ({ where, data }) => {
      if (!state.method) return { count: 0 };
      if (where.enabledAt === null && state.method.enabledAt) return { count: 0 };
      if (where.OR && state.method.lastUsedStep !== null && data.lastUsedStep <= state.method.lastUsedStep) return { count: 0 };
      Object.assign(state.method, data); return { count: 1 };
    }),
  },
  mfaRecoveryCode: {
    deleteMany: vi.fn(async () => { state.codes = []; }),
    createMany: vi.fn(async ({ data }) => { state.codes = data.map((item, index) => ({ ...item, id: `code-${index}`, usedAt: null })); }),
    findUnique: vi.fn(async ({ where }) => state.codes.find((item) => item.tokenHash === where.tokenHash) || null),
    updateMany: vi.fn(async ({ where, data }) => { const row = state.codes.find((item) => item.id === where.id && !item.usedAt); if (!row) return { count: 0 }; Object.assign(row, data); return { count: 1 }; }),
  },
  mfaLoginChallenge: {
    create: vi.fn(async ({ data }) => { state.challenge = { id: 'challenge-1', attempts: 0, consumedAt: null, ...data }; return state.challenge; }),
    findUnique: vi.fn(async ({ where }) => state.challenge?.tokenHash === where.tokenHash ? state.challenge : null),
    updateMany: vi.fn(async ({ where, data }) => {
      if (!state.challenge || state.challenge.id !== where.id || state.challenge.consumedAt || state.challenge.attempts >= 5) return { count: 0 };
      if (data.attempts) state.challenge.attempts += 1;
      else Object.assign(state.challenge, data);
      return { count: 1 };
    }),
  },
  userProfile: { upsert: vi.fn(async () => ({})) },
  authSession: { updateMany: vi.fn(async () => ({ count: 1 })) },
  $transaction: vi.fn(async (work) => work(prisma)),
};
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { base32Decode, base32Encode, decryptSecret, encryptSecret, totpAt } = await import('../src/modules/auth/auth.mfa-crypto.js');
const { beginEnrollment, beginLoginChallenge, confirmEnrollment, consumeLoginChallenge } = await import('../src/modules/auth/auth.mfa.js');

beforeEach(async () => {
  vi.clearAllMocks(); state.method = null; state.codes = []; state.challenge = null;
  process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  prisma.user.findUnique.mockResolvedValue({ email: 'patient@example.test', password: await bcrypt.hash('correct-password', 4) });
});

describe('TOTP and recovery security', () => {
  it('matches the RFC 6238 SHA-1 vector and encrypts the secret at rest', () => {
    const secret = Buffer.from('12345678901234567890');
    expect(totpAt(secret, 59, 8)).toBe('94287082');
    expect(base32Decode(base32Encode(secret))).toEqual(secret);
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toContain(secret.toString());
    expect(decryptSecret(encrypted)).toEqual(secret);
  });

  it('requires password-backed enrollment, rejects OTP replay, and consumes a recovery code once', async () => {
    await expect(beginEnrollment('user-1', 'wrong')).rejects.toMatchObject({ code: 'MFA_DENIED' });
    const enrollment = await beginEnrollment('user-1', 'correct-password');
    expect(enrollment.otpauthUri).toContain('otpauth://totp/');
    expect(state.method.encryptedSecret).not.toContain(enrollment.secret);
    const code = totpAt(base32Decode(enrollment.secret), Math.floor(Date.now() / 1000));
    const recoveryCodes = await confirmEnrollment('user-1', code, 'session-1');
    expect(recoveryCodes).toHaveLength(10);
    expect(state.codes[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(state.codes[0].tokenHash).not.toBe(recoveryCodes[0]);
    const challengeToken = await beginLoginChallenge('user-1');
    await expect(consumeLoginChallenge(challengeToken, { code })).rejects.toMatchObject({ code: 'MFA_DENIED' });
    expect(await consumeLoginChallenge(challengeToken, { recoveryCode: recoveryCodes[0] })).toBe('user-1');
    await expect(consumeLoginChallenge(challengeToken, { recoveryCode: recoveryCodes[1] })).rejects.toMatchObject({ code: 'MFA_DENIED' });
    const secondChallenge = await beginLoginChallenge('user-1');
    await expect(consumeLoginChallenge(secondChallenge, { recoveryCode: recoveryCodes[0] })).rejects.toMatchObject({ code: 'MFA_DENIED' });
  });
});
