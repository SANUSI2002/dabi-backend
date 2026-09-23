import { describe, expect, it, vi } from 'vitest';
import { bootstrapFirstTestPlatformAdmin, validateTestBootstrap } from '../scripts/bootstrap-test-platform-admin.mjs';

const databaseUrl = 'postgresql://user:password@localhost/sabi_backend_test_db';
const email = 'operator@example.test';

describe('first test platform administrator bootstrap', () => {
  it('rejects other databases and requires explicit confirmation to apply', () => {
    expect(() => validateTestBootstrap({ databaseUrl: 'postgresql://user:password@localhost/production', email })).toThrow('restricted');
    expect(() => validateTestBootstrap({ databaseUrl, email, apply: true })).toThrow('confirmation');
    expect(validateTestBootstrap({ databaseUrl, email: ' Operator@Example.Test ', apply: true, confirmation: 'grant-test-platform-admin' })).toBe(email);
  });

  it('dry-runs without writing, then assigns and audits exactly one existing active account', async () => {
    const tx = {
      user: { findMany: vi.fn().mockResolvedValue([{ id: 'user-1', accountStatus: 'ACTIVE' }]) },
      platformRoleAssignment: { findUnique: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(0), create: vi.fn().mockResolvedValue({}) },
      accessRole: { findUnique: vi.fn().mockResolvedValue({ scope: 'PLATFORM' }) },
      activityLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: (work) => work(tx) };
    expect((await bootstrapFirstTestPlatformAdmin(prisma, email)).status).toBe('dry-run');
    expect(tx.platformRoleAssignment.create).not.toHaveBeenCalled();
    expect((await bootstrapFirstTestPlatformAdmin(prisma, email, { apply: true })).status).toBe('assigned');
    expect(tx.platformRoleAssignment.create).toHaveBeenCalledWith({ data: { userId: 'user-1', roleCode: 'SABI_PLATFORM_ADMIN' } });
    expect(tx.activityLog.create).toHaveBeenCalledOnce();
  });

  it('refuses a second administrator or an inactive identity', async () => {
    const tx = {
      user: { findMany: vi.fn().mockResolvedValue([{ id: 'user-1', accountStatus: 'ACTIVE' }]) },
      platformRoleAssignment: { findUnique: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(1) },
    };
    const prisma = { $transaction: (work) => work(tx) };
    await expect(bootstrapFirstTestPlatformAdmin(prisma, email, { apply: true })).rejects.toThrow('already exists');
    tx.user.findMany.mockResolvedValue([{ id: 'user-1', accountStatus: 'SUSPENDED' }]);
    await expect(bootstrapFirstTestPlatformAdmin(prisma, email, { apply: true })).rejects.toThrow('active Sabi ID');
  });
});
