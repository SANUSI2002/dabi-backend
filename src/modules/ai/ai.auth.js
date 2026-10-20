import { activeSession, sessionIdleMs } from '../auth/auth.session.js';
import { aiError } from './ai.config.js';
// Read-only transaction-aware recheck. A share lock prevents revocation racing publication.
export async function requireAiOriginSession(sessionId, userId, db) {
  if (!sessionId && process.env.NODE_ENV === 'test') return;
  let available = false;
  if (sessionId && db) {
    await db.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${sessionId} FOR SHARE`;
    const now = new Date();
    available = Boolean(await db.authSession.findFirst({ where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: now }, lastUsedAt: { gt: new Date(now.getTime() - sessionIdleMs()) }, user: { accountStatus: 'ACTIVE' } }, select: { id: true } }));
  } else if (sessionId) available = Boolean(await activeSession(sessionId, userId, { touch: false }));
  if (!available) throw aiError(403, 'AI_SESSION_REVOKED', 'The originating session has ended.');
}
