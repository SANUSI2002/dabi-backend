import prisma from '../../config/db.js';
import { aiAvailable, aiError, requireAiAvailable } from './ai.config.js';
export const generationAvailable = async (db = prisma) => {
  if (!aiAvailable()) return false;
  const policy = await db.aiRuntimePolicy.findUnique({ where: { id: 'global' } });
  return Boolean(policy && !policy.generationPaused);
};
export async function requireGenerationAvailable(db = prisma) {
  requireAiAvailable();
  const policy = await db.aiRuntimePolicy.findUnique({ where: { id: 'global' } });
  if (!policy) throw aiError(503, 'AI_UNAVAILABLE', 'Sabi AI controls are temporarily unavailable.');
  if (policy.generationPaused) throw aiError(503, 'AI_GENERATION_PAUSED', 'New Sabi AI responses are temporarily paused. Saved conversations and normal Sabi services remain available.');
}
