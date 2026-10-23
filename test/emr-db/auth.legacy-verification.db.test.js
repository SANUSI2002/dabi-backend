import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prisma } from './fixtures.js';
import { confirmEmailVerificationToken } from '../../src/modules/auth/auth.model.js';

async function fixture({ status = 'ACTIVE', role = 'PATIENT', verified = false, ...tokenChanges } = {}) {
  const tag = randomUUID();
  const user = await prisma.user.create({ data: { email: `${tag}@legacy.test`, patientId: `LEGACY-${tag}`, password: 'synthetic-not-a-password', accountStatus: status, emailVerifiedAt: verified ? new Date() : null, roles: { create: { role } } } });
  const hash = createHash('sha256').update(randomBytes(32)).digest('hex');
  const token = await prisma.emailVerificationToken.create({ data: { userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + 60_000), ...tokenChanges } });
  return { user, token, hash };
}

describe('legacy patient email verification against PostgreSQL', () => {
  it.each(['ACTIVE', 'PENDING'])('requires a real one-use token for a %s patient and revokes other links', async (status) => {
    const { user, hash, token } = await fixture({ status });
    const other = await prisma.emailVerificationToken.create({ data: { userId: user.id, tokenHash: randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + 60_000) } });
    expect(await confirmEmailVerificationToken(randomUUID(), hash)).toBe(false);
    expect(await confirmEmailVerificationToken(user.id, hash)).toBe(true);
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toMatchObject({ accountStatus: 'ACTIVE', emailVerifiedAt: expect.any(Date) });
    expect((await prisma.emailVerificationToken.findUnique({ where: { id: token.id } })).usedAt).toBeInstanceOf(Date);
    expect((await prisma.emailVerificationToken.findUnique({ where: { id: other.id } })).revokedAt).toBeInstanceOf(Date);
    expect(await confirmEmailVerificationToken(user.id, hash)).toBe(false);
  });

  it.each([
    { status: 'SUSPENDED' }, { status: 'DISABLED' }, { status: 'BANNED' },
    { role: 'PROFESSIONAL' }, { verified: true },
    { expiresAt: new Date(0) }, { usedAt: new Date() }, { revokedAt: new Date() },
  ])('never verifies or reactivates an ineligible account/token: %j', async (options) => {
    const { user, hash, token } = await fixture(options);
    expect(await confirmEmailVerificationToken(user.id, hash)).toBe(false);
    const unchanged = await prisma.user.findUnique({ where: { id: user.id } });
    expect(unchanged.accountStatus).toBe(user.accountStatus);
    expect(unchanged.emailVerifiedAt).toEqual(user.emailVerifiedAt);
    expect((await prisma.emailVerificationToken.findUnique({ where: { id: token.id } })).usedAt).toEqual(token.usedAt);
  });

  it('preserves the pending professional onboarding verification path', async () => {
    const { user, hash } = await fixture({ status: 'PENDING', role: 'PROFESSIONAL' });
    expect(await confirmEmailVerificationToken(user.id, hash)).toBe(true);
  });
});
