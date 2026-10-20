import prisma from '../../config/db.js';
import { recordAudit } from '../audit/audit.service.js';
import { updateScheduleInTransaction } from '../medication-schedules/schedule.service.js';
import { aiError } from './ai.config.js';

const missing = () => aiError(404, 'AI_ACTION_NOT_FOUND', 'This account action is unavailable.');
const audit = (db, userId, action, id) => recordAudit(db, { actorUserId: userId, action, resourceType: 'AI_ACTION_PROPOSAL', resourceId: id });
async function actor(userId, db) {
  if (!await db.user.findFirst({ where: { id: userId, accountStatus: 'ACTIVE', emailVerifiedAt: { not: null } }, select: { id: true } })) throw aiError(403, 'AI_ACCOUNT_UNAVAILABLE', 'A verified, active account is required.');
}
async function conversation(userId, sessionId, db) {
  await actor(userId, db);
  if (!await db.aiSession.findFirst({ where: { id: sessionId, ownerUserId: userId, archivedAt: null }, select: { id: true } })) throw missing();
}
const fields = { id: true, sessionId: true, scheduleId: true, scheduleVersion: true, enableReminders: true, status: true, createdAt: true, expiresAt: true, confirmedAt: true, receipt: { select: { id: true, result: true, createdAt: true } } };
export async function reminderActionTargets(userId) {
  await actor(userId, prisma);
  return prisma.medicationSchedule.findMany({ where: { userId, status: 'ACTIVE', asNeeded: false }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100,
    select: { id: true, name: true, remindersEnabled: true, timezone: true, version: true } });
}
export async function listAiActions(userId, sessionId) {
  await conversation(userId, sessionId, prisma);
  return prisma.aiActionProposal.findMany({ where: { ownerUserId: userId, sessionId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50, select: fields });
}
export async function proposeReminderAction(userId, sessionId, input) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    await conversation(userId, sessionId, tx);
    const prior = await tx.aiActionProposal.findUnique({ where: { ownerUserId_clientRequestId: { ownerUserId: userId, clientRequestId: input.clientRequestId } }, select: fields });
    if (prior) {
      if (prior.sessionId !== sessionId || prior.scheduleId !== input.scheduleId || prior.scheduleVersion !== input.expectedVersion || prior.enableReminders !== input.enableReminders) throw aiError(409, 'AI_IDEMPOTENCY_CONFLICT', 'This action reference was already used for a different change.');
      return prior;
    }
    const schedule = await tx.medicationSchedule.findFirst({ where: { id: input.scheduleId, userId, status: 'ACTIVE', asNeeded: false } });
    if (!schedule) throw missing();
    if (schedule.version !== input.expectedVersion) throw aiError(409, 'AI_ACTION_CHANGED', 'The reminder changed. Refresh before preparing a change.');
    if (schedule.remindersEnabled === input.enableReminders) throw aiError(409, 'AI_ACTION_NO_CHANGE', 'These reminders already have that setting.');
    if (await tx.aiActionProposal.count({ where: { ownerUserId: userId, status: 'PENDING', expiresAt: { gt: new Date() } } }) >= 10) throw aiError(429, 'AI_ACTION_LIMIT', 'Confirm or cancel an outstanding change before creating another.');
    const row = await tx.aiActionProposal.create({ data: { ownerUserId: userId, sessionId, scheduleId: schedule.id, scheduleVersion: schedule.version, enableReminders: input.enableReminders, clientRequestId: input.clientRequestId, expiresAt: new Date(Date.now() + 10 * 60000) }, select: fields });
    await audit(tx, userId, 'AI_ACTION_PROPOSED', row.id); return row;
  });
}
export async function confirmAiAction(userId, id) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`; await actor(userId, tx);
    await tx.$queryRaw`SELECT id FROM ai_action_proposals WHERE id = ${id} AND owner_user_id = ${userId} FOR UPDATE`;
    const proposal = await tx.aiActionProposal.findFirst({ where: { id, ownerUserId: userId }, select: fields });
    if (!proposal) throw missing();
    await conversation(userId, proposal.sessionId, tx);
    if (proposal.status === 'APPLIED') return proposal.receipt;
    if (proposal.status !== 'PENDING' || proposal.expiresAt <= new Date()) throw aiError(409, 'AI_ACTION_EXPIRED', 'This confirmation is no longer valid. Prepare a fresh preview.');
    await tx.$queryRaw`SELECT id FROM medication_schedules WHERE id = ${proposal.scheduleId} AND user_id = ${userId} FOR UPDATE`;
    const schedule = await tx.medicationSchedule.findFirst({ where: { id: proposal.scheduleId, userId, status: 'ACTIVE', asNeeded: false, version: proposal.scheduleVersion } });
    if (!schedule) throw aiError(409, 'AI_ACTION_CHANGED', 'The medicine or reminder settings changed. Prepare a fresh preview.');
    const result = await updateScheduleInTransaction(tx, userId, schedule.id, { remindersEnabled: proposal.enableReminders });
    const receipt = await tx.aiActionReceipt.create({ data: { proposalId: id, result: { action: 'REMINDER_TOGGLE', scheduleId: result.id, remindersEnabled: result.remindersEnabled, scheduleVersion: result.version, treatmentChanged: false } }, select: { id: true, result: true, createdAt: true } });
    await tx.aiActionProposal.update({ where: { id }, data: { status: 'APPLIED', confirmedAt: receipt.createdAt } });
    await audit(tx, userId, 'AI_ACTION_APPLIED', id); return receipt;
  });
}
export async function cancelAiAction(userId, id) {
  return prisma.$transaction(async (tx) => {
    await actor(userId, tx);
    const result = await tx.aiActionProposal.updateMany({ where: { id, ownerUserId: userId, status: 'PENDING', session: { archivedAt: null } }, data: { status: 'CANCELLED' } });
    if (!result.count) throw missing(); await audit(tx, userId, 'AI_ACTION_CANCELLED', id); return { cancelled: true };
  });
}
