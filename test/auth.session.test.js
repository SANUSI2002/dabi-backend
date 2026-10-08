import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = { device: null, session: null, credentials: [] };
const prisma = {
  authDevice: {
    create: vi.fn(async ({ data }) => { state.device = { id: 'device-1', ...data }; return state.device; }),
    update: vi.fn(async ({ data }) => Object.assign(state.device, data)),
  },
  authSession: {
    create: vi.fn(async ({ data }) => { state.session = { id: 'session-1', createdAt: new Date(), revokedAt: null, ...data }; return state.session; }),
    findFirst: vi.fn(async ({ where }) => state.session?.id === where.id && state.session.userId === where.userId && !state.session.revokedAt ? state.session : null),
    findMany: vi.fn(async () => state.session && !state.session.revokedAt ? [{ id: state.session.id }] : []),
    updateMany: vi.fn(async ({ where, data }) => {
      if (state.session?.id !== where.id && where.id?.in && !where.id.in.includes(state.session?.id)) return { count: 0 };
      if (state.session?.revokedAt) return { count: 0 };
      Object.assign(state.session, data); return { count: 1 };
    }),
  },
  authRefreshCredential: {
    create: vi.fn(async ({ data }) => { const row = { id: `credential-${state.credentials.length + 1}`, consumedAt: null, revokedAt: null, ...data }; state.credentials.push(row); return row; }),
    findUnique: vi.fn(async ({ where, include }) => {
      const row = state.credentials.find((item) => item.tokenHash === where.tokenHash);
      return row ? { ...row, ...(include ? { session: { ...state.session } } : {}) } : null;
    }),
    updateMany: vi.fn(async ({ where, data }) => {
      const rows = state.credentials.filter((item) => (where.id ? item.id === where.id && !item.consumedAt : item.sessionId === where.sessionId && !item.revokedAt));
      rows.forEach((item) => Object.assign(item, data)); return { count: rows.length };
    }),
  },
  $transaction: vi.fn(async (arg) => typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
  auditEvent: { create: vi.fn(async ({ data }) => data), findFirst: vi.fn() },
};
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { activeSession, createSession, revokeSession, rotateRefreshToken } = await import('../src/modules/auth/auth.session.js');

beforeEach(() => { vi.clearAllMocks(); state.device = null; state.session = null; state.credentials = []; });

describe('server-backed sessions', () => {
  it('stores only a hash, rotates refresh credentials, and rejects the old credential as replay', async () => {
    const issued = await createSession({ id: 'user-1' }, 'Chrome on Windows');
    expect(state.credentials[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(state.credentials[0].tokenHash).not.toBe(issued.refreshToken);
    const rotated = await rotateRefreshToken(issued.refreshToken);
    expect(rotated.refreshToken).not.toBe(issued.refreshToken);
    expect(state.credentials[0].consumedAt).toBeInstanceOf(Date);
    expect(state.credentials).toHaveLength(2);
    await expect(rotateRefreshToken(issued.refreshToken)).rejects.toMatchObject({ code: 'SESSION_REPLAY' });
    expect(state.session.revokedAt).toBeInstanceOf(Date);
    await expect(rotateRefreshToken(rotated.refreshToken)).rejects.toMatchObject({ code: 'SESSION_INVALID' });
  });

  it('invalidates access sessions immediately after revocation', async () => {
    const { session } = await createSession({ id: 'user-1' });
    expect(await activeSession(session.id, 'user-1')).toBeTruthy();
    await revokeSession(session.id);
    expect(await activeSession(session.id, 'user-1')).toBeNull();
  });

  it('revokes a session left idle past the limit, together with its refresh credential', async () => {
    const issued = await createSession({ id: 'user-1' });
    state.session.lastUsedAt = new Date(Date.now() - 5 * 60_000 - 1000);
    expect(await activeSession(issued.session.id, 'user-1')).toBeNull();
    expect(state.session.revokedAt).toBeInstanceOf(Date);
    expect(state.credentials[0].revokedAt).toBeInstanceOf(Date);
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorUserId: 'user-1', action: 'SIGNED_OUT_IDLE', category: 'SIGN_IN' }) });
  });

  it('records activity at most every 30 seconds and never when only inspecting', async () => {
    const issued = await createSession({ id: 'user-1' });
    const recent = new Date(Date.now() - 10_000);
    state.session.lastUsedAt = recent;
    expect(await activeSession(issued.session.id, 'user-1')).toBeTruthy();
    expect(state.session.lastUsedAt).toBe(recent);
    state.session.lastUsedAt = new Date(Date.now() - 60_000);
    expect(await activeSession(issued.session.id, 'user-1', { touch: false })).toBeTruthy();
    expect(Date.now() - state.session.lastUsedAt.getTime()).toBeGreaterThanOrEqual(60_000);
    expect(await activeSession(issued.session.id, 'user-1')).toBeTruthy();
    expect(Date.now() - state.session.lastUsedAt.getTime()).toBeLessThan(1000);
  });

  it('refuses to refresh an idle session and revokes it', async () => {
    const issued = await createSession({ id: 'user-1' });
    state.session.lastUsedAt = new Date(Date.now() - 6 * 60_000);
    await expect(rotateRefreshToken(issued.refreshToken)).rejects.toMatchObject({ code: 'SESSION_IDLE' });
    expect(state.session.revokedAt).toBeInstanceOf(Date);
    expect(state.credentials).toHaveLength(1);
  });

  it('honours a configured idle limit', async () => {
    vi.stubEnv('SESSION_IDLE_MINUTES', '15');
    try {
      const issued = await createSession({ id: 'user-1' });
      state.session.lastUsedAt = new Date(Date.now() - 10 * 60_000);
      expect(await activeSession(issued.session.id, 'user-1')).toBeTruthy();
    } finally { vi.unstubAllEnvs(); }
  });
});
