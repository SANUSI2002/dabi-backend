import { createHash } from 'node:crypto';
import prisma from '../../config/db.js';
import { recordAudit } from '../audit/audit.service.js';
import { aiError } from './ai.config.js';

const projection = { id: true, kind: true, content: true, revision: true, sourceSessionId: true, createdAt: true, updatedAt: true };
async function actor(userId, db = prisma) {
  if (!await db.user.findFirst({ where: { id: userId, accountStatus: 'ACTIVE', emailVerifiedAt: { not: null } }, select: { id: true } })) throw aiError(403, 'AI_ACCOUNT_UNAVAILABLE', 'A verified, active Sabi account is required.');
}
export async function listAiMemory(userId, db = prisma) {
  await actor(userId, db);
  return db.aiPersonalMemory.findMany({ where: { ownerUserId: userId, deletedAt: null }, orderBy: { id: 'asc' }, take: 50, select: projection });
}
export const memoryVersion = (items) => createHash('sha256').update(JSON.stringify(items.map(({ id, revision, content, kind }) => ({ id, revision, content, kind })))).digest('hex');
export async function saveAiMemory(userId, input, id) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    await actor(userId, tx);
    const all = await tx.aiPersonalMemory.findMany({ where: { ownerUserId: userId, deletedAt: null }, select: { id: true, content: true } });
    if (all.filter((item) => item.id !== id).reduce((sum, item) => sum + item.content.length, input.content.length) > 8000) throw aiError(429, 'AI_MEMORY_LIMIT', 'Saved memory is limited to 8,000 characters in total. Shorten or delete an entry first.');
    if (input.sourceSessionId && !await tx.aiSession.findFirst({ where: { id: input.sourceSessionId, ownerUserId: userId, archivedAt: null }, select: { id: true } })) throw aiError(404, 'AI_NOT_FOUND', 'The source conversation is not available.');
    if (id) {
      const existing = await tx.aiPersonalMemory.findFirst({ where: { id, ownerUserId: userId, deletedAt: null } });
      if (!existing) throw aiError(404, 'AI_NOT_FOUND', 'This memory is not available.');
      if (existing.revision !== input.revision) throw aiError(409, 'AI_MEMORY_CONFLICT', 'This memory changed. Reload it before saving your correction.');
      const result = await tx.aiPersonalMemory.updateMany({ where: { id, ownerUserId: userId, revision: input.revision, deletedAt: null }, data: { content: input.content, kind: input.kind, revision: { increment: 1 } } });
      if (!result.count) throw aiError(409, 'AI_MEMORY_CONFLICT', 'This memory changed. Reload it before saving your correction.');
    } else {
      if (await tx.aiPersonalMemory.count({ where: { ownerUserId: userId, deletedAt: null } }) >= 50) throw aiError(429, 'AI_MEMORY_LIMIT', 'You can save up to 50 memories. Delete one before adding another.');
      const row = await tx.aiPersonalMemory.create({ data: { ownerUserId: userId, kind: input.kind, content: input.content, sourceSessionId: input.sourceSessionId || null } }); id = row.id;
    }
    await recordAudit(tx, { actorUserId: userId, action: 'AI_MEMORY_SAVED', resourceType: 'AI_MEMORY', resourceId: id });
    return tx.aiPersonalMemory.findUnique({ where: { id }, select: projection });
  });
}
export async function deleteAiMemory(userId, id) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    await actor(userId, tx);
    const deleted = await tx.aiPersonalMemory.updateMany({ where: { id, ownerUserId: userId, deletedAt: null }, data: { content: '', deletedAt: new Date(), revision: { increment: 1 } } });
    if (!deleted.count) throw aiError(404, 'AI_NOT_FOUND', 'This memory is not available.');
    await recordAudit(tx, { actorUserId: userId, action: 'AI_MEMORY_DELETED', resourceType: 'AI_MEMORY', resourceId: id });
    return { deleted: true };
  });
}
