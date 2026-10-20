import { z } from 'zod';
import prisma from '../../config/db.js';
import { aiError } from './ai.config.js';
import { notify } from '../notifications/notify.service.js';

const integer = (max) => z.number().int().min(0).max(max);
export const allowanceSettingsSchema = z.object({
  personalDailyRequests: integer(10000), professionalDailyRequests: integer(10000),
  personalTokenAllowance: integer(10000000), professionalTokenAllowance: integer(10000000),
  tokenResetCadence: z.enum(['DAILY', 'MONTHLY']), resetTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timeZone: z.enum(['UTC', 'Africa/Lagos', 'Europe/London', 'America/New_York', 'Asia/Dubai']),
  monthlyResetDay: z.number().int().min(1).max(28), maxTokensPerRequest: z.number().int().min(128).max(64000),
  maxOutputTokens: z.number().int().min(128).max(2048), globalDailyRequests: integer(1000000),
  globalTotalRequests: integer(10000000), warningPercent: z.number().int().min(1).max(99),
}).strict().refine((s) => s.maxOutputTokens <= s.maxTokensPerRequest, { message: 'Output limit cannot exceed the per-request token limit.', path: ['maxOutputTokens'] });
export const allowanceLock = (tx) => tx.$queryRaw`SELECT pg_advisory_xact_lock(739294, 1)::text`;
export async function allowancePolicy(db = prisma) {
  const row = await db.aiAllowancePolicy.findUnique({ where: { id: 'global' } });
  const settings = allowanceSettingsSchema.safeParse(row?.settings);
  if (!row || !settings.success) throw aiError(503, 'AI_ALLOWANCE_UNAVAILABLE', 'AI allowance settings are temporarily unavailable.');
  return { ...row, settings: settings.data };
}

// PostgreSQL resolves IANA offsets/DST. Store windows once: editing a schedule never refills an open period.
export async function allowanceBoundaries(tx, settings, now = new Date()) {
  const [hour, minute] = settings.resetTime.split(':').map(Number);
  const [row] = await tx.$queryRaw`
    WITH local_clock AS (SELECT ${now}::timestamptz AT TIME ZONE ${settings.timeZone} AS wall),
    anchors AS (SELECT wall, date_trunc('day',wall) + (${hour * 60 + minute} * interval '1 minute') AS daily,
      date_trunc('month',wall) + (${settings.monthlyResetDay - 1} * interval '1 day') + (${hour * 60 + minute} * interval '1 minute') AS monthly FROM local_clock),
    starts AS (SELECT CASE WHEN wall<daily THEN daily-interval '1 day' ELSE daily END AS daily,
      CASE WHEN wall<monthly THEN monthly-interval '1 month' ELSE monthly END AS monthly FROM anchors)
    SELECT (extract(epoch FROM (daily AT TIME ZONE ${settings.timeZone}))*1000)::double precision AS "requestStart",
      (extract(epoch FROM ((daily+interval '1 day') AT TIME ZONE ${settings.timeZone}))*1000)::double precision AS "requestEnd",
      (extract(epoch FROM ((CASE WHEN ${settings.tokenResetCadence}='MONTHLY' THEN monthly ELSE daily END) AT TIME ZONE ${settings.timeZone}))*1000)::double precision AS "tokenStart",
      (extract(epoch FROM ((CASE WHEN ${settings.tokenResetCadence}='MONTHLY' THEN monthly+interval '1 month' ELSE daily+interval '1 day' END) AT TIME ZONE ${settings.timeZone}))*1000)::double precision AS "tokenEnd" FROM starts`;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, new Date(Number(value))]));
}
async function initialUsage(tx, userId, kind, start, end) {
  if (kind === 'REQUEST') {
    const createdAt = { gte: start, lt: end };
    return await tx.aiRun.count({ where: { session: { ownerUserId: userId }, createdAt } }) + await tx.aiDocumentSource.count({ where: { ownerUserId: userId, createdAt } });
  }
  // Only pre-ledger history needs importing. New work settles against its explicit reservation.
  const runs = await tx.aiRun.findMany({ where: { session: { ownerUserId: userId }, createdAt: { gte: start, lt: end } }, select: { id: true, usage: true } });
  const docs = await tx.aiDocumentSource.findMany({ where: { ownerUserId: userId, createdAt: { gte: start, lt: end } }, select: { id: true, usage: true } });
  const reservations = await tx.aiAllowanceReservation.findMany({ where: { userId, resourceId: { in: [...runs, ...docs].map((r) => r.id) } }, select: { resourceId: true } });
  const known = new Set(reservations.map((r) => r.resourceId));
  return [...runs, ...docs].filter((r) => !known.has(r.id)).reduce((sum, r) => sum + (usageTotal(r.usage) ?? 0), 0);
}
function usageTotal(usage) {
  if (!usage || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0) return null;
  const sum = usage.inputTokens + usage.outputTokens;
  return Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= sum ? usage.totalTokens : sum;
}
async function currentWindow(tx, userId, kind, start, end, now) {
  const current = await tx.aiAllowanceWindow.findFirst({ where: { userId, kind, startsAt: { lte: now }, endsAt: { gt: now } }, orderBy: { startsAt: 'desc' } });
  if (current) return current;
  const previous = await tx.aiAllowanceWindow.findFirst({ where: { userId, kind }, orderBy: { endsAt: 'desc' } });
  if (previous && start < previous.endsAt) start = previous.endsAt;
  const usedUnits = await initialUsage(tx, userId, kind, start, end);
  const row = await tx.aiAllowanceWindow.create({ data: { userId, kind, startsAt: start, endsAt: end, usedUnits } });
  await tx.aiAllowanceLedger.create({ data: { userId, windowId: row.id, eventKey: `open:${row.id}`, type: 'PERIOD_OPENED', usedDelta: usedUnits } });
  return row;
}
export async function allowanceSnapshot(tx, userId, { now = new Date() } = {}) {
  const policy = await allowancePolicy(tx);
  const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, accountStatus: true, professionalProfile: { select: { verificationStatus: true } } } });
  if (!user) throw aiError(404, 'AI_ACCOUNT_NOT_FOUND', 'Sabi account not found.');
  const account = await tx.aiAllowanceAccount.upsert({ where: { userId }, create: { userId }, update: {} });
  const professional = user.professionalProfile?.verificationStatus === 'VERIFIED';
  const settings = policy.settings;
  const dailyLimit = account.dailyRequestOverride ?? (professional ? settings.professionalDailyRequests : settings.personalDailyRequests);
  const tokenLimit = account.tokenAllowanceOverride ?? (professional ? settings.professionalTokenAllowance : settings.personalTokenAllowance);
  const bounds = await allowanceBoundaries(tx, settings, now);
  const requests = await currentWindow(tx, userId, 'REQUEST', bounds.requestStart, bounds.requestEnd, now);
  const tokens = await currentWindow(tx, userId, 'TOKEN', bounds.tokenStart, bounds.tokenEnd, now);
  // An explicit zero disables generation even if an earlier period adjustment remains.
  const allocation = tokenLimit === 0 ? 0 : Math.max(0, tokenLimit + tokens.bonusUnits);
  const remaining = Math.max(0, allocation - tokens.usedUnits - tokens.reservedUnits);
  return { userId, accountVersion: account.version, plan: professional ? 'PROFESSIONAL' : 'PERSONAL', accountStatus: user.accountStatus,
    overrides: { dailyRequests: account.dailyRequestOverride, tokenAllowance: account.tokenAllowanceOverride },
    requests: { limit: dailyLimit, used: requests.usedUnits, remaining: Math.max(0, dailyLimit - requests.usedUnits), resetsAt: requests.endsAt },
    tokens: { limit: tokenLimit, bonus: tokens.bonusUnits, allocated: allocation, used: tokens.usedUnits, reserved: tokens.reservedUnits, remaining, resetsAt: tokens.endsAt,
      status: remaining === 0 ? 'EXHAUSTED' : tokens.usedUnits + tokens.reservedUnits >= allocation * settings.warningPercent / 100 ? 'LOW' : 'AVAILABLE' },
    policyVersion: policy.version, settings, requestWindowId: requests.id, tokenWindowId: tokens.id };
}
export const publicAllowance = (snapshot) => { const safe = { ...snapshot, resetSchedule: { cadence: snapshot.settings.tokenResetCadence, time: snapshot.settings.resetTime, timeZone: snapshot.settings.timeZone } }; delete safe.requestWindowId; delete safe.tokenWindowId; delete safe.settings; return safe; };
export async function getAllowance(userId) {
  return prisma.$transaction(async (tx) => { await allowanceLock(tx); return publicAllowance(await allowanceSnapshot(tx, userId)); });
}
export async function reserveAllowance(tx, userId, resourceKind, resourceId, { existingRequest = false } = {}) {
  await allowanceLock(tx);
  const prior = await tx.aiAllowanceReservation.findUnique({ where: { resourceKind_resourceId: { resourceKind, resourceId } } });
  if (prior) { if (prior.userId !== userId) throw aiError(409, 'AI_ALLOWANCE_CONFLICT', 'AI allowance reservation conflict.'); return prior; }
  const snapshot = await allowanceSnapshot(tx, userId);
  if (snapshot.accountStatus !== 'ACTIVE') throw aiError(403, 'AI_ACCOUNT_UNAVAILABLE', 'An active Sabi account is required.');
  if (!existingRequest && !snapshot.requests.remaining) throw aiError(429, 'AI_USER_QUOTA', `Your daily request allowance is used. It resets at ${snapshot.requests.resetsAt.toISOString()}.`);
  const since = (await allowanceBoundaries(tx, snapshot.settings)).requestStart;
  const [runsDay, docsDay, runsTotal, docsTotal] = await Promise.all([
    tx.aiRun.count({ where: { createdAt: { gte: since } } }), tx.aiDocumentSource.count({ where: { createdAt: { gte: since } } }), tx.aiRun.count(), tx.aiDocumentSource.count(),
  ]);
  if (!existingRequest && (runsDay + docsDay >= snapshot.settings.globalDailyRequests || runsTotal + docsTotal >= snapshot.settings.globalTotalRequests)) throw aiError(429, 'AI_SERVICE_QUOTA', 'The shared Sabi AI service allowance is used. Your other Sabi services remain available.');
  const reservedTokens = Math.min(snapshot.settings.maxTokensPerRequest, snapshot.tokens.remaining);
  if (reservedTokens < 128) throw aiError(429, 'AI_TOKEN_QUOTA', 'Your remaining AI tokens cannot cover another response. Check your balance and reset time.');
  const row = await tx.aiAllowanceReservation.create({ data: { userId, resourceKind, resourceId, requestWindowId: snapshot.requestWindowId, tokenWindowId: snapshot.tokenWindowId, reservedTokens, maxOutputTokens: snapshot.settings.maxOutputTokens } });
  if (!existingRequest) {
    await tx.aiAllowanceWindow.update({ where: { id: snapshot.requestWindowId }, data: { usedUnits: { increment: 1 } } });
    await tx.aiAllowanceLedger.create({ data: { userId, windowId: snapshot.requestWindowId, eventKey: `request:${row.id}`, type: 'REQUEST_RESERVED', usedDelta: 1 } });
  }
  await tx.aiAllowanceWindow.update({ where: { id: snapshot.tokenWindowId }, data: { reservedUnits: { increment: reservedTokens } } });
  await tx.aiAllowanceLedger.create({ data: { userId, windowId: snapshot.tokenWindowId, eventKey: `reserve:${row.id}`, type: 'TOKENS_RESERVED', reservedDelta: reservedTokens, metadata: { resourceKind, resourceId } } });
  return row;
}
export async function dispatchAllowance(userId, resourceKind, resourceId) {
  return prisma.$transaction(async (tx) => {
    await allowanceLock(tx);
    const row = await reserveAllowance(tx, userId, resourceKind, resourceId, { existingRequest: true });
    if (row.state !== 'RESERVED') throw aiError(409, 'AI_ALLOWANCE_CONFLICT', 'This AI request was already dispatched.');
    return tx.aiAllowanceReservation.update({ where: { id: row.id }, data: { state: 'DISPATCHED', dispatchedAt: new Date() } });
  });
}
export async function finishAllowance(tx, resourceKind, resourceId, { usage, notDispatched = false } = {}) {
  await allowanceLock(tx);
  const row = await tx.aiAllowanceReservation.findUnique({ where: { resourceKind_resourceId: { resourceKind, resourceId } } });
  if (!row || ['SETTLED', 'RELEASED'].includes(row.state)) return;
  const total = usageTotal(usage);
  if (total !== null) {
    if (total > 10000000) throw aiError(503, 'AI_USAGE_INVALID', 'AI usage requires review.');
    await tx.aiAllowanceWindow.update({ where: { id: row.tokenWindowId }, data: { usedUnits: { increment: total }, reservedUnits: { decrement: row.reservedTokens } } });
    await tx.aiAllowanceReservation.update({ where: { id: row.id }, data: { state: 'SETTLED', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: total, settledAt: new Date() } });
    await tx.aiAllowanceLedger.create({ data: { userId: row.userId, windowId: row.tokenWindowId, eventKey: `settle:${row.id}`, type: total > row.reservedTokens ? 'TOKEN_OVERAGE' : 'TOKENS_SETTLED', usedDelta: total, reservedDelta: -row.reservedTokens, metadata: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: total, reservation: row.reservedTokens } } });
    const current = await allowanceSnapshot(tx, row.userId);
    if (current.tokenWindowId === row.tokenWindowId && current.tokens.used >= current.tokens.allocated * current.settings.warningPercent / 100) {
      const exhausted = current.tokens.used >= current.tokens.allocated;
      await notify(tx, { userId: row.userId, eventType: 'account.notice', title: exhausted ? 'Sabi AI token allowance used' : 'Sabi AI tokens running low',
        message: `${current.tokens.used.toLocaleString('en-NG')} of ${current.tokens.allocated.toLocaleString('en-NG')} tokens used. Your current period resets at ${current.tokens.resetsAt.toISOString()}.`, eventKey: `ai-token:${row.tokenWindowId}:${exhausted ? 'exhausted' : 'warning'}` });
    }
  } else if (!row.dispatchedAt || notDispatched) {
    await tx.aiAllowanceWindow.update({ where: { id: row.tokenWindowId }, data: { reservedUnits: { decrement: row.reservedTokens } } });
    await tx.aiAllowanceReservation.update({ where: { id: row.id }, data: { state: 'RELEASED', settledAt: new Date() } });
    await tx.aiAllowanceLedger.create({ data: { userId: row.userId, windowId: row.tokenWindowId, eventKey: `release:${row.id}`, type: 'TOKENS_RELEASED', reservedDelta: -row.reservedTokens } });
  } else await tx.aiAllowanceReservation.update({ where: { id: row.id }, data: { state: 'UNCERTAIN' } });
}
export const settleAllowance = (kind, id, options) => prisma.$transaction((tx) => finishAllowance(tx, kind, id, options));
