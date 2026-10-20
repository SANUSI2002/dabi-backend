import { requireGenerationAvailable } from './ai.policy.js';
import { reserveAllowance } from './ai.allowances.js';
export const dayStart = () => { const now = new Date(); now.setUTCHours(0, 0, 0, 0); return now; };
// Cross-instance, transaction-scoped reservation shared by chat and extraction.
// This is a request allowance, not a promise about provider charges or cloud spend.
export async function reserveAiQuota(tx, userId, kind, resourceId) {
  await requireGenerationAvailable(tx);
  return reserveAllowance(tx, userId, kind, resourceId);
}
