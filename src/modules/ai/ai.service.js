import { createHash, randomUUID } from 'node:crypto';
import prisma from '../../config/db.js';
import { recordAudit } from '../audit/audit.service.js';
import { AI_CONSENT_VERSION, aiConfig, aiDocumentsAvailable, aiError } from './ai.config.js';
import { promptVersion } from './ai.prompt.js';
import { generateAiResponse } from './ai.provider.js';
import { listAiMemory, memoryVersion } from './ai.memory.js';
import { generationAvailable, requireGenerationAvailable } from './ai.policy.js';
import { dayStart, reserveAiQuota } from './ai.quota.js';
import { retrieveAiSources, sourceContextAvailable } from './ai.sources.js';
import { requireAiOriginSession } from './ai.auth.js';
import { dispatchAllowance, finishAllowance, settleAllowance, getAllowance } from './ai.allowances.js';

const active = ['QUEUED', 'RUNNING'];
const controllers = new Map();
export const abortAiRuns = () => { for (const controller of controllers.values()) controller.abort(); };
const missing = () => aiError(404, 'AI_NOT_FOUND', 'This Sabi AI conversation or response is not available.');
export const publicRun = (run) => ({ id: run.id, sessionId: run.sessionId, status: run.status,
  createdAt: run.createdAt, finishedAt: run.finishedAt, errorCode: run.errorCode,
  citations: run.sourceContext?.passages || [],
  ...(run.status === 'SUCCEEDED' ? { answer: run.messages?.find((m) => m.role === 'assistant')?.content ?? null } : {}),
});
async function actor(userId, db = prisma) {
  const user = await db.user.findFirst({ where: { id: userId, accountStatus: 'ACTIVE', emailVerifiedAt: { not: null } }, select: { id: true } });
  if (!user) throw aiError(403, 'AI_ACCOUNT_UNAVAILABLE', 'A verified, active Sabi account is required.');
}
async function owned(userId, id, db = prisma) {
  await actor(userId, db);
  const session = await db.aiSession.findFirst({ where: { id, ownerUserId: userId, archivedAt: null } });
  if (!session) throw missing();
  return session;
}
const audit = (db, userId, action, id) => recordAudit(db, { actorUserId: userId, action, resourceType: 'AI_CONVERSATION', resourceId: id });
export async function createAiSession(userId, input) {
  await requireGenerationAvailable(); await actor(userId);
  return prisma.$transaction(async (tx) => {
    const row = await tx.aiSession.create({ data: { ownerUserId: userId, title: input.title || 'New conversation', consentVersion: AI_CONSENT_VERSION } });
    await audit(tx, userId, 'AI_CONVERSATION_CREATED', row.id); return row;
  });
}
export async function listAiSessions(userId) {
  await actor(userId);
  return prisma.aiSession.findMany({ where: { ownerUserId: userId, archivedAt: null }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 50,
    select: { id: true, title: true, mode: true, createdAt: true, updatedAt: true } });
}
export async function getAiSession(userId, id) {
  const session = await owned(userId, id);
  const messages = await prisma.aiMessage.findMany({ where: { sessionId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100,
    select: { id: true, role: true, content: true, runId: true, createdAt: true } });
  await recordAudit(prisma, { actorUserId: userId, action: 'AI_CONVERSATION_VIEWED', resourceType: 'AI_CONVERSATION', resourceId: id }, { dedupeMinutes: 5 });
  const runs = await prisma.aiRun.findMany({ where: { sessionId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100,
    select: { id: true, sessionId: true, clientMessageId: true, status: true, errorCode: true, feedback: true, sourceContext: true, createdAt: true, finishedAt: true } });
  const visible = await visibleAiMessages(userId, messages.reverse(), runs);
  return { ...session, messages: visible, runs: runs.map((run) => { const safe = { ...run }; delete safe.sourceContext; return safe; }) };
}
async function visibleAiMessages(userId, messages, runs, db = prisma) {
  const visible = new Map();
  for (const run of runs) visible.set(run.id, await sourceContextAvailable(userId, run.sourceContext, db));
  return messages.map((m) => m.role !== 'assistant' ? m : visible.get(m.runId) === false
    ? { ...m, content: 'This response is no longer available because its source was removed or changed.', citations: [], sourceUnavailable: true }
    : { ...m, citations: runs.find((r) => r.id === m.runId)?.sourceContext?.passages || [] });
}
export async function queueAiMessage(user, id, input) {
  await requireGenerationAvailable();
  const sourceIds = [...new Set(input.sourceIds || [])].sort();
  const requestHash = createHash('sha256').update(JSON.stringify({ message: input.message, sourceIds })).digest('hex');
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM ai_sessions WHERE id = ${id} FOR UPDATE`;
      await owned(user.id, id, tx);
      const existing = await tx.aiRun.findUnique({ where: { sessionId_clientMessageId: { sessionId: id, clientMessageId: input.clientMessageId } }, include: { messages: true } });
      if (existing) {
        if (existing.requestHash !== requestHash) throw aiError(409, 'AI_IDEMPOTENCY_CONFLICT', 'This message ID was already used for different content.');
        return await sourceContextAvailable(user.id, existing.sourceContext, tx) ? publicRun(existing) : { ...publicRun(existing), answer: undefined, citations: [], sourceUnavailable: true };
      }
      if (await tx.aiRun.findFirst({ where: { sessionId: id, status: { in: active } } })) throw aiError(409, 'AI_RESPONSE_IN_PROGRESS', 'Wait for or cancel the current response first.');
      const context = sourceIds.length ? await retrieveAiSources(user.id, sourceIds, input.message, tx) : null;
      const runId = randomUUID();
      await reserveAiQuota(tx, user.id, 'CHAT', runId);
      const run = await tx.aiRun.create({ data: { id: runId, sessionId: id, clientMessageId: input.clientMessageId, requestHash,
        authSessionId: user.sessionId || null, model: aiConfig().model, promptVersion,
        ...(context ? { sourceContext: { versions: context.versions, passages: context.passages.map((p) => { const safe = { ...p }; delete safe.text; delete safe.score; return safe; }) } } : {}) } });
      await tx.aiMessage.create({ data: { sessionId: id, runId: run.id, role: 'user', content: input.message } });
      await tx.aiSession.update({ where: { id }, data: { updatedAt: new Date() } });
      await audit(tx, user.id, 'AI_RESPONSE_REQUESTED', id); return publicRun(run);
    });
  } catch (error) {
    if (error.code === 'P2002') throw aiError(409, 'AI_RESPONSE_CONFLICT', 'Another message is already being processed. Please reload the conversation.');
    throw error;
  }
}
export async function renameAiSession(userId, id, title) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM ai_sessions WHERE id = ${id} FOR UPDATE`;
    await owned(userId, id, tx);
    const row = await tx.aiSession.update({ where: { id }, data: { title } });
    await audit(tx, userId, 'AI_CONVERSATION_RENAMED', id); return row;
  });
}
export async function deleteAiSession(userId, id) {
  const runIds = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM ai_sessions WHERE id = ${id} FOR UPDATE`;
    await owned(userId, id, tx);
    const runs = await tx.aiRun.findMany({ where: { sessionId: id, status: { in: active } }, select: { id: true } });
    await tx.aiRun.updateMany({ where: { sessionId: id, status: { in: active } }, data: { status: 'CANCELLED', errorCode: null, finishedAt: new Date() } });
    for (const run of runs) await finishAllowance(tx, 'CHAT', run.id);
    await tx.aiMessage.deleteMany({ where: { sessionId: id } });
    await tx.aiPersonalMemory.updateMany({ where: { sourceSessionId: id, deletedAt: null }, data: { content: '', deletedAt: new Date(), revision: { increment: 1 } } });
    await tx.aiActionProposal.updateMany({ where: { sessionId: id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
    await tx.aiSession.update({ where: { id }, data: { title: 'Deleted conversation', archivedAt: new Date() } });
    await audit(tx, userId, 'AI_CONVERSATION_DELETED', id); return runs.map((run) => run.id);
  });
  for (const runId of runIds) controllers.get(runId)?.abort();
  return { deleted: true, retained: 'Completed action receipts and minimal audit and usage metadata are retained. Previously confirmed reminder changes are not undone. Backup copies follow the backup retention policy. No signed clinical records were changed.' };
}
export async function exportAiSession(userId, id) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM ai_sessions WHERE id = ${id} FOR UPDATE`;
    const session = await owned(userId, id, tx);
    const messages = await tx.aiMessage.findMany({ where: { sessionId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 5001,
      select: { role: true, content: true, createdAt: true, runId: true } });
    if (messages.length > 5000) throw aiError(422, 'AI_EXPORT_TOO_LARGE', 'This conversation needs a larger data export. Contact Sabi support.');
    await audit(tx, userId, 'AI_CONVERSATION_EXPORTED', id);
    const runs = await tx.aiRun.findMany({ where: { sessionId: id }, select: { id: true, sourceContext: true } });
    const actionReceipts = await tx.aiActionReceipt.findMany({ where: { proposal: { sessionId: id, ownerUserId: userId } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 5001, select: { id: true, result: true, createdAt: true } });
    if (actionReceipts.length > 5000) throw aiError(422, 'AI_EXPORT_TOO_LARGE', 'This conversation needs a larger data export. Contact Sabi support.');
    return { schemaVersion: 1, exportedAt: new Date(), conversation: { id: session.id, title: session.title, mode: session.mode, createdAt: session.createdAt }, messages: await visibleAiMessages(userId, messages, runs, tx), actionReceipts };
  });
}
export async function getAiUsage(userId) {
  await actor(userId); const since = dayStart();
  const [total, completed, documentToday, documentTotal] = await Promise.all([
    prisma.aiRun.count({ where: { session: { ownerUserId: userId } } }),
    prisma.aiRun.count({ where: { session: { ownerUserId: userId }, status: 'SUCCEEDED' } }),
    prisma.aiDocumentSource.count({ where: { ownerUserId: userId, createdAt: { gte: since } } }), prisma.aiDocumentSource.count({ where: { ownerUserId: userId } }),
  ]);
  const allowance = await getAllowance(userId);
  return { today: allowance.requests.used, total: total + documentTotal, completed, documentToday, documentTotal, dailyAllowance: allowance.requests.limit, resetsAt: allowance.requests.resetsAt, billingEnabled: false, allowance };
}
export async function rateAiRun(userId, id, feedback) {
  await getAiRun(userId, id);
  return prisma.$transaction(async (tx) => {
    const row = await tx.aiRun.updateMany({ where: { id, status: 'SUCCEEDED', session: { ownerUserId: userId, archivedAt: null } }, data: { feedback, feedbackAt: new Date() } });
    if (!row.count) throw aiError(409, 'AI_FEEDBACK_UNAVAILABLE', 'Only a completed response can be reviewed.');
    await audit(tx, userId, 'AI_RESPONSE_REVIEWED', id); return { recorded: true, feedback };
  });
}
export async function getAiRun(userId, id) {
  await actor(userId);
  const run = await prisma.aiRun.findFirst({ where: { id, session: { ownerUserId: userId, archivedAt: null } }, include: { messages: true } });
  if (!run) throw missing();
  if (!await sourceContextAvailable(userId, run.sourceContext)) return { ...publicRun(run), answer: undefined, citations: [], sourceUnavailable: true };
  return publicRun(run);
}
export async function cancelAiRun(userId, id) {
  await getAiRun(userId, id);
  const result = await prisma.$transaction(async (tx) => {
    const changed = await tx.aiRun.updateMany({ where: { id, status: { in: active }, session: { ownerUserId: userId } }, data: { status: 'CANCELLED', errorCode: null, finishedAt: new Date() } });
    if (changed.count) await audit(tx, userId, 'AI_RESPONSE_CANCELLED', id);
    if (changed.count) await finishAllowance(tx, 'CHAT', id);
    return publicRun(await tx.aiRun.findUnique({ where: { id }, include: { messages: true } }));
  });
  if (result.status === 'CANCELLED') controllers.get(id)?.abort();
  return getAiRun(userId, id);
}
async function authorisedRun(run) {
  await actor(run.session.ownerUserId);
  if (run.session.archivedAt) throw missing();
  await requireAiOriginSession(run.authSessionId, run.session.ownerUserId);
}
// Durable jobs; no provider call inside a database transaction. Never auto-replay an uncertain call.
export async function processAiQueue({ generate = generateAiResponse } = {}) {
  if (process.env.SABI_AI_ENABLED !== 'true') return 0;
  const stale = await prisma.aiRun.findMany({ where: { status: 'RUNNING', startedAt: { lt: new Date(Date.now() - 120_000) } }, include: { session: true }, take: 25 });
  for (const run of stale) await finishFailure(run, 'AI_RUN_INTERRUPTED');
  if (!await generationAvailable()) return 0;
  const next = await prisma.aiRun.findFirst({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' }, include: { session: true } });
  if (!next) return 0;
  const claim = await prisma.aiRun.updateMany({ where: { id: next.id, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: new Date() } });
  if (!claim.count) return 0;
  const controller = new globalThis.AbortController(); controllers.set(next.id, controller);
  try {
    await authorisedRun(next);
    if (next.promptVersion !== promptVersion || next.model !== aiConfig().model) throw aiError(409, 'AI_CONFIGURATION_CHANGED', 'The AI configuration changed.');
    const previous = await prisma.aiMessage.findMany({ where: { sessionId: next.sessionId, run: { status: 'SUCCEEDED' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20, include: { run: { select: { sourceContext: true } } } });
    const current = await prisma.aiMessage.findUnique({ where: { runId_role: { runId: next.id, role: 'user' } } });
    const history = []; let size = current.content.length;
    for (const message of previous) { if (!await sourceContextAvailable(next.session.ownerUserId, message.run.sourceContext)) continue; if (size + message.content.length > 24_000) break; history.push(message); size += message.content.length; }
    history.reverse(); while (history[0]?.role === 'assistant') history.shift();
    const memories = await listAiMemory(next.session.ownerUserId);
    const usedMemoryVersion = memoryVersion(memories);
    const context = next.sourceContext?.versions?.length ? await retrieveAiSources(next.session.ownerUserId, next.sourceContext.versions.map((v) => v.sourceId), current.content) : { passages: [] };
    if (!await sourceContextAvailable(next.session.ownerUserId, next.sourceContext)) throw aiError(409, 'AI_CONTEXT_CHANGED', 'Selected source context changed.');
    const allocation = await dispatchAllowance(next.session.ownerUserId, 'CHAT', next.id);
    const result = await generate([...history, current], { signal: controller.signal, memories, sources: context.passages, tokenBudget: allocation.reservedTokens, maxOutputTokens: allocation.maxOutputTokens });
    // Provider usage survives cancellation or a later publication rejection.
    await settleAllowance('CHAT', next.id, { usage: result.usage });
    const cited = [...result.text.matchAll(/\[S(\d+)\]/g)].map((m) => `S${m[1]}`);
    if (cited.some((label) => !context.passages.some((p) => p.label === label))) throw aiError(503, 'AI_RESPONSE_INVALID', 'Sabi returned an unsupported source reference.');
    await requireGenerationAvailable(); await authorisedRun(next);
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${next.session.ownerUserId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM ai_sessions WHERE id = ${next.sessionId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM ai_runs WHERE id = ${next.id} FOR UPDATE`;
      if ((await tx.aiRun.findUnique({ where: { id: next.id } })).status !== 'RUNNING') return;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(739294, 1)::text`;
      await requireGenerationAvailable(tx);
      await owned(next.session.ownerUserId, next.sessionId, tx);
      await requireAiOriginSession(next.authSessionId, next.session.ownerUserId, tx);
      if (next.sourceContext?.versions?.length && !aiDocumentsAvailable()) throw aiError(409, 'AI_CONTEXT_CHANGED', 'Document AI processing was withdrawn.');
      if (!await sourceContextAvailable(next.session.ownerUserId, next.sourceContext, tx, { lock: true })) throw aiError(409, 'AI_CONTEXT_CHANGED', 'Selected document context changed.');
      // Revocation/correction during provider work invalidates the answer, not just later retrieval.
      if (memoryVersion(await listAiMemory(next.session.ownerUserId, tx)) !== usedMemoryVersion) throw aiError(409, 'AI_CONTEXT_CHANGED', 'Saved context changed while the response was being prepared.');
      await tx.aiMessage.create({ data: { sessionId: next.sessionId, runId: next.id, role: 'assistant', content: result.text } });
      await tx.aiRun.update({ where: { id: next.id }, data: { status: 'SUCCEEDED', usage: { ...result.usage, memoryVersion: usedMemoryVersion, memoryCount: memories.length }, finishedAt: new Date() } });
      await tx.aiSession.update({ where: { id: next.sessionId }, data: { updatedAt: new Date() } });
      await audit(tx, next.session.ownerUserId, 'AI_RESPONSE_COMPLETED', next.sessionId);
    });
  } catch (error) {
    await settleAllowance('CHAT', next.id, { usage: error.usage, notDispatched: error.aiProviderDispatched === false });
    const allowed = ['AI_TOKEN_QUOTA', 'AI_GENERATION_PAUSED', 'AI_CONTEXT_CHANGED', 'AI_PROVIDER_BUSY', 'AI_PROVIDER_UNAVAILABLE', 'AI_RESPONSE_INCOMPLETE', 'AI_RESPONSE_INVALID', 'AI_SESSION_REVOKED', 'AI_CONFIGURATION_CHANGED', 'AI_UNAVAILABLE', 'AI_ACCOUNT_UNAVAILABLE'];
    await finishFailure(next, allowed.includes(error.code) ? error.code : 'AI_RESPONSE_FAILED');
  } finally {
    controllers.delete(next.id);
  }
  return 1;
}
async function finishFailure(run, code) {
  await prisma.$transaction(async (tx) => {
    const changed = await tx.aiRun.updateMany({ where: { id: run.id, status: { in: active } }, data: { status: 'FAILED', errorCode: code, finishedAt: new Date() } });
    await finishAllowance(tx, 'CHAT', run.id);
    if (changed.count) await audit(tx, run.session.ownerUserId, 'AI_RESPONSE_FAILED', run.sessionId);
  });
}
