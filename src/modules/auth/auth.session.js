import crypto from 'node:crypto';
import prisma from '../../config/db.js';
import { recordAudit } from '../audit/audit.service.js';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto.randomBytes(48).toString('base64url');
const sessionDays = Math.min(30, Math.max(1, Number(process.env.SESSION_DAYS) || 7));
const maxSessionDays = Math.min(365, Math.max(sessionDays, Number(process.env.SESSION_MAX_DAYS) || 90));
const sessionExpiry = () => new Date(Date.now() + sessionDays * 86_400_000);
const invalid = () => Object.assign(new Error('Invalid or revoked refresh token'), { code: 'SESSION_INVALID' });

// Inactivity limit. A session with no authenticated request (or refresh) for this long is revoked,
// so a closed laptop or forgotten browser cannot be resumed. Clients also sign out locally after the
// same period without user input, and their background polling stops once they do.
const idleMinutes = () => Math.min(120, Math.max(1, Number(process.env.SESSION_IDLE_MINUTES) || 5));
export const sessionIdleMs = () => idleMinutes() * 60_000;
const isIdle = (session, now) => now.getTime() - new Date(session.lastUsedAt).getTime() >= sessionIdleMs();
// Recording use on every request would write once per API call; once per 30 seconds is precise enough.
const TOUCH_INTERVAL_MS = 30_000;

// One device at a time: signing in ends the account's other sessions. Their next request (or the
// clients' session check, every few seconds) is refused with SIGNED_IN_ELSEWHERE so they can say why.
// SINGLE_DEVICE_SESSIONS=false allows several devices again.
export const SIGNED_IN_ELSEWHERE = 'SIGNED_IN_ELSEWHERE';
const singleDevice = () => process.env.SINGLE_DEVICE_SESSIONS !== 'false';

/** Resolves to { session, refreshToken, replaced } — `replaced` counts sessions ended on other devices. */
export const createSession = async (user, userAgent = '', { mfaVerified = false } = {}) => {
  const refreshToken = randomToken();
  const expiresAt = sessionExpiry();
  const agent = userAgent.slice(0, 512);
  return prisma.$transaction(async (tx) => {
    // Two sign-ins at the same moment queue here, so exactly one session survives.
    if (singleDevice()) await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${user.id} FOR UPDATE`;
    const device = await tx.authDevice.create({ data: {
      userId: user.id,
      label: agent ? agent.slice(0, 160) : 'Unknown browser',
      userAgent: agent || null,
    } });
    const session = await tx.authSession.create({ data: { userId: user.id, deviceId: device.id, expiresAt, ...(mfaVerified ? { mfaVerifiedAt: new Date() } : {}) } });
    await tx.authRefreshCredential.create({ data: { sessionId: session.id, tokenHash: hash(refreshToken), expiresAt } });
    let replaced = 0;
    if (singleDevice()) {
      const now = new Date();
      const others = (await tx.authSession.findMany({ where: { userId: user.id, revokedAt: null, id: { not: session.id } }, select: { id: true } })).map(({ id }) => id);
      if (others.length) {
        await tx.authSession.updateMany({ where: { id: { in: others }, revokedAt: null }, data: { revokedAt: now, revokedReason: SIGNED_IN_ELSEWHERE } });
        await tx.authRefreshCredential.updateMany({ where: { sessionId: { in: others }, revokedAt: null }, data: { revokedAt: now } });
        replaced = others.length;
      }
    }
    return { session, refreshToken, replaced };
  });
};

/** Why a session ended (e.g. SIGNED_IN_ELSEWHERE), or null. */
export const sessionEndReason = async (sessionId) => (sessionId
  ? (await prisma.authSession.findUnique({ where: { id: sessionId }, select: { revokedReason: true } }))?.revokedReason ?? null
  : null);

/**
 * The live session behind an access token, or null when it is revoked, expired, suspended or idle.
 * An idle session is revoked on the spot so its refresh credential dies with it. `touch` records this
 * request as activity; pass false when merely inspecting a session (e.g. one the user is revoking).
 */
export const activeSession = async (sessionId, userId, { touch = true } = {}) => {
  if (!sessionId) return null;
  const now = new Date();
  const session = await prisma.authSession.findFirst({ where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: now }, user: { accountStatus: 'ACTIVE' } } });
  if (!session) return null;
  if (isIdle(session, now)) {
    await revokeIdleSession(session.id, session.userId);
    return null;
  }
  if (touch && now.getTime() - new Date(session.lastUsedAt).getTime() >= TOUCH_INTERVAL_MS) {
    // Conditional on the value read, so concurrent requests write at most once.
    await prisma.authSession.updateMany({ where: { id: session.id, revokedAt: null, lastUsedAt: session.lastUsedAt }, data: { lastUsedAt: now } });
  }
  return session;
};

export const rotateRefreshToken = async (rawToken) => {
  if (typeof rawToken !== 'string' || !rawToken) throw invalid();
  const credential = await prisma.authRefreshCredential.findUnique({
    where: { tokenHash: hash(rawToken) },
    include: { session: true },
  });
  if (!credential) throw invalid();
  if (credential.consumedAt) {
    await revokeSession(credential.sessionId);
    throw Object.assign(invalid(), { code: 'SESSION_REPLAY' });
  }
  const now = new Date();
  if (credential.session.revokedReason === SIGNED_IN_ELSEWHERE) throw Object.assign(invalid(), { code: SIGNED_IN_ELSEWHERE });
  if (credential.revokedAt || credential.expiresAt <= now || credential.session.revokedAt || credential.session.expiresAt <= now) throw invalid();
  if (isIdle(credential.session, now)) {
    await revokeIdleSession(credential.sessionId, credential.session.userId);
    throw Object.assign(invalid(), { code: 'SESSION_IDLE' });
  }
  const nextToken = randomToken();
  const absoluteExpiry = new Date(credential.session.createdAt.getTime() + maxSessionDays * 86_400_000);
  if (absoluteExpiry <= now) throw invalid();
  const nextExpiry = new Date(Math.min(sessionExpiry().getTime(), absoluteExpiry.getTime()));
  const result = await prisma.$transaction(async (tx) => {
    const consumed = await tx.authRefreshCredential.updateMany({
      where: { id: credential.id, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) return null;
    const session = await tx.authSession.updateMany({
      where: { id: credential.sessionId, revokedAt: null, expiresAt: { gt: now } },
      data: { lastUsedAt: now, expiresAt: nextExpiry },
    });
    if (session.count !== 1) return null;
    await tx.authRefreshCredential.create({ data: { sessionId: credential.sessionId, tokenHash: hash(nextToken), expiresAt: nextExpiry } });
    await tx.authDevice.update({ where: { id: credential.session.deviceId }, data: { lastSeenAt: now } });
    return { sessionId: credential.sessionId, userId: credential.session.userId, refreshToken: nextToken };
  });
  if (!result) {
    await revokeSession(credential.sessionId);
    throw Object.assign(invalid(), { code: 'SESSION_REPLAY' });
  }
  return result;
};

/** Ends a session; resolves to true when it was still open. */
export const revokeSession = async (sessionId) => {
  const now = new Date();
  const [sessions] = await prisma.$transaction([
    prisma.authSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now } }),
    prisma.authRefreshCredential.updateMany({ where: { sessionId, revokedAt: null }, data: { revokedAt: now } }),
  ]);
  return sessions.count > 0;
};

// An idle session is ended wherever it is noticed first; only that first ending is recorded.
const revokeIdleSession = async (sessionId, userId) => {
  if (await revokeSession(sessionId)) await recordAudit(prisma, { actorUserId: userId, action: 'SIGNED_OUT_IDLE', resourceType: 'session', resourceId: sessionId });
};

export const revokeUserSessions = async (userId, exceptSessionId) => {
  const now = new Date();
  const where = { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) };
  const sessions = await prisma.authSession.findMany({ where, select: { id: true } });
  if (!sessions.length) return 0;
  const ids = sessions.map(({ id }) => id);
  await prisma.$transaction([
    prisma.authSession.updateMany({ where: { id: { in: ids } }, data: { revokedAt: now } }),
    prisma.authRefreshCredential.updateMany({ where: { sessionId: { in: ids }, revokedAt: null }, data: { revokedAt: now } }),
  ]);
  return ids.length;
};

export const listSessions = (userId) => prisma.authSession.findMany({
  where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
  select: { id: true, createdAt: true, lastUsedAt: true, expiresAt: true, device: { select: { id: true, label: true, userAgent: true } } },
  orderBy: { lastUsedAt: 'desc' },
});

export const sessionIdForRefresh = async (rawToken) => {
  const credential = await prisma.authRefreshCredential.findUnique({ where: { tokenHash: hash(rawToken) }, select: { sessionId: true } });
  return credential?.sessionId ?? null;
};

export const userIdForRefresh = async (rawToken) => {
  if (!rawToken) return null;
  const credential = await prisma.authRefreshCredential.findUnique({
    where: { tokenHash: hash(rawToken) },
    include: { session: { select: { userId: true, revokedAt: true, expiresAt: true, lastUsedAt: true } } },
  });
  if (credential?.consumedAt) {
    await revokeSession(credential.sessionId);
    throw Object.assign(invalid(), { code: 'SESSION_REPLAY' });
  }
  const now = new Date();
  if (!credential || credential.revokedAt || credential.expiresAt <= now || credential.session.revokedAt || credential.session.expiresAt <= now) return null;
  if (isIdle(credential.session, now)) { await revokeIdleSession(credential.sessionId, credential.session.userId); return null; }
  return credential?.session?.userId ?? null;
};
