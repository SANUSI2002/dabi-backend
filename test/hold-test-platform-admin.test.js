import { describe, expect, it, vi } from 'vitest';
import { holdTestPlatformAdmin, validateTestHold } from '../scripts/hold-test-platform-admin.mjs';

const databaseUrl = 'postgresql://user:password@localhost/sabi_backend_test_db';
const email = 'operator@example.test';

describe('test platform administrator hold', () => {
  it('requires the disposable database and explicit confirmation to apply', () => {
    expect(() => validateTestHold({ databaseUrl: 'postgresql://user:password@localhost/production', email })).toThrow('restricted');
    expect(() => validateTestHold({ databaseUrl, email, apply: true })).toThrow('confirmation');
    expect(validateTestHold({ databaseUrl, email, apply: true, confirmation: 'hold-test-platform-admin' })).toBe(email);
  });

  it('dry-runs, then removes only the named role, revokes sessions, and audits', async () => {
    const tx = {
      user: { findMany: vi.fn().mockResolvedValue([{ id: 'user-1' }]) },
      platformRoleAssignment: { findUnique: vi.fn().mockResolvedValue({}), delete: vi.fn().mockResolvedValue({}) },
      authSession: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      refreshToken: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      activityLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: (work) => work(tx) };
    expect((await holdTestPlatformAdmin(prisma, email)).status).toBe('dry-run');
    expect(tx.platformRoleAssignment.delete).not.toHaveBeenCalled();
    expect((await holdTestPlatformAdmin(prisma, email, { apply: true })).status).toBe('held');
    expect(tx.platformRoleAssignment.delete).toHaveBeenCalledWith({ where: { userId_roleCode: { userId: 'user-1', roleCode: 'SABI_PLATFORM_ADMIN' } } });
    expect(tx.authSession.updateMany).toHaveBeenCalledOnce();
    expect(tx.refreshToken.deleteMany).toHaveBeenCalledOnce();
    expect(tx.activityLog.create).toHaveBeenCalledOnce();
  });

  it('does not modify an account with no assignment', async () => {
    const tx = {
      user: { findMany: vi.fn().mockResolvedValue([{ id: 'user-1' }]) },
      platformRoleAssignment: { findUnique: vi.fn().mockResolvedValue(null), delete: vi.fn() },
    };
    const prisma = { $transaction: (work) => work(tx) };
    expect((await holdTestPlatformAdmin(prisma, email, { apply: true })).status).toBe('already-held');
    expect(tx.platformRoleAssignment.delete).not.toHaveBeenCalled();
  });
});
