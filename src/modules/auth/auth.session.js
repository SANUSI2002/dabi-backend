import crypto from 'node:crypto';
import prisma from '../../config/db.js';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto.randomBytes(48).toString('base64url');
const sessionDays = Math.min(30, Math.max(1, Number(process.env.SESSION_DAYS) || 7));
const maxSessionDays = Math.min(365, Math.max(sessionDays, Number(process.env.SESSION_MAX_DAYS) || 90));
const sessionExpiry = () => new Date(Date.now() + sessionDays * 86_400_000);
const invalid = () => Object.assign(new Error('Invalid or revoked refresh token'), { code: 'SESSION_INVALID' });

export const createSession = async (user, userAgent = '', { mfaVerified = false } = {}) => {
  const refreshToken = randomToken();
  const expiresAt = sessionExpiry();
  const agent = userAgent.slice(0, 512);
  return prisma.$transaction(async (tx) => {
    const device = await tx.authDevice.create({ data: {
      userId: user.id,
      label: agent ? agent.slice(0, 160) : 'Unknown browser',
      userAgent: agent || null,
    } });
    const session = await tx.authSession.create({ data: { userId: user.id, deviceId: device.id, expiresAt, ...(mfaVerified ? { mfaVerifiedAt: new Date() } : {}) } });
    await tx.authRefreshCredential.create({ data: { sessionId: session.id, tokenHash: hash(refreshToken), expiresAt } });
    return { session, refreshToken };
  });
};

export const activeSession = async (sessionId, userId) => {
  if (!sessionId) return null;
  return prisma.authSession.findFirst({ where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() }, user: { accountStatus: 'ACTIVE' } } });
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
  if (credential.revokedAt || credential.expiresAt <= now || credential.session.revokedAt || credential.session.expiresAt <= now) throw invalid();
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

export const revokeSession = async (sessionId) => {
  const now = new Date();
  await prisma.$transaction([
    prisma.authSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now } }),
    prisma.authRefreshCredential.updateMany({ where: { sessionId, revokedAt: null }, data: { revokedAt: now } }),
  ]);
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
    include: { session: { select: { userId: true, revokedAt: true, expiresAt: true } } },
  });
  if (credential?.consumedAt) {
    await revokeSession(credential.sessionId);
    throw Object.assign(invalid(), { code: 'SESSION_REPLAY' });
  }
  if (!credential || credential.revokedAt || credential.expiresAt <= new Date() || credential.session.revokedAt || credential.session.expiresAt <= new Date()) return null;
  return credential?.session?.userId ?? null;
};
