import { aiError, aiLimits } from './ai.config.js';
import { requireGenerationAvailable } from './ai.policy.js';
export const dayStart = () => { const now = new Date(); now.setUTCHours(0, 0, 0, 0); return now; };
// Cross-instance, transaction-scoped reservation shared by chat and extraction.
// This is a request allowance, not a promise about provider charges or cloud spend.
export async function reserveAiQuota(tx, userId) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(739294, 1)::text`;
  await requireGenerationAvailable(tx);
  const limits = aiLimits(); const since = dayStart();
  const [userDay, globalDay, total, sourceUserDay, sourceDay, sourceTotal] = await Promise.all([
    tx.aiRun.count({ where: { session: { ownerUserId: userId }, createdAt: { gte: since } } }),
    tx.aiRun.count({ where: { createdAt: { gte: since } } }), tx.aiRun.count(),
    tx.aiDocumentSource.count({ where: { ownerUserId: userId, createdAt: { gte: since } } }),
    tx.aiDocumentSource.count({ where: { createdAt: { gte: since } } }), tx.aiDocumentSource.count(),
  ]);
  if (userDay + sourceUserDay >= limits.userDailyRuns) throw aiError(429, 'AI_USER_QUOTA', 'Your daily Sabi AI allowance has been reached. It resets at midnight UTC.');
  if (globalDay + sourceDay >= limits.globalDailyRuns || total + sourceTotal >= limits.globalTotalRuns) throw aiError(429, 'AI_SERVICE_QUOTA', 'Sabi AI has reached its service allowance. Your other Sabi services remain available.');
}
