import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { prisma, tokenFor } from './fixtures.js';
import { app } from '../../src/app.js';
import { allowancePolicy, allowanceBoundaries, allowanceLock, allowanceSnapshot, reserveAllowance, finishAllowance, getAllowance, dispatchAllowance } from '../../src/modules/ai/ai.allowances.js';
const createUser = () => prisma.user.create({ data: { patientId: `AL-${randomUUID()}`, email: `${randomUUID()}@allowance.test`, password: 'synthetic', accountStatus: 'ACTIVE', emailVerifiedAt: new Date() } });
let defaults, admin;
const tx = (fn) => prisma.$transaction(async (db) => { await allowanceLock(db); return fn(db); });
const reserve = (u, id = randomUUID(), kind = 'CHAT') => tx((db) => reserveAllowance(db, u.id, kind, id));
const finish = (r, options) => tx((db) => finishAllowance(db, r.resourceKind, r.resourceId, options));
const post = (url, body, user = admin) => request(app).post(`/api/v1/command-centre/ai/allowances${url}`).set('Authorization', tokenFor(user.id)).send(body);
beforeAll(async () => { defaults = (await allowancePolicy()).settings; admin = await createUser(); await prisma.platformRoleAssignment.create({ data: { userId: admin.id, roleCode: 'SABI_PLATFORM_ADMIN' } }); });
beforeEach(async () => { await prisma.aiAllowancePolicy.update({ where: { id: 'global' }, data: { settings: { ...defaults, personalDailyRequests: 10, professionalDailyRequests: 10, personalTokenAllowance: 1000, professionalTokenAllowance: 1000, maxTokensPerRequest: 500, maxOutputTokens: 128, globalDailyRequests: 100000, globalTotalRequests: 100000 } } }); });
afterAll(async () => { await prisma.aiAllowancePolicy.update({ where: { id: 'global' }, data: { settings: defaults } }); });

describe('durable AI allowances', () => {
  it('searches an email without treating the search term as a UUID and hides balances from non-admins', async () => {
    const u = await createUser();
    const result = await request(app).get('/api/v1/command-centre/ai/allowances/users').query({ q: u.email }).set('Authorization', tokenFor(admin.id));
    expect(result.status).toBe(200); expect(result.body.data.items.map((item) => item.id)).toEqual([u.id]);
    const denied = await request(app).get('/api/v1/command-centre/ai/allowances/users').set('Authorization', tokenFor(u.id));
    expect(denied.status).toBe(403);
  });
  it('automatically gives each new account its own balance and reserves across conversation/document entry points', async () => {
    const a = await createUser(), b = await createUser();
    expect((await getAllowance(a.id)).tokens.remaining).toBe(1000);
    const first = await reserve(a); await reserve(a, randomUUID(), 'DOCUMENT');
    expect((await getAllowance(a.id)).tokens.reserved).toBe(1000);
    expect((await getAllowance(b.id)).tokens.remaining).toBe(1000);
    await expect(reserve(a)).rejects.toMatchObject({ code: 'AI_TOKEN_QUOTA' });
    await finish(first); expect((await getAllowance(a.id)).tokens.remaining).toBe(500);
  });
  it('never allocates twice for the same request and never settles twice', async () => {
    const u = await createUser(), id = randomUUID();
    const first = await reserve(u, id); expect((await reserve(u, id)).id).toBe(first.id);
    const usage = { inputTokens: 40, outputTokens: 15, totalTokens: 60 };
    await finish(first, { usage }); await finish(first, { usage });
    const state = await getAllowance(u.id);
    expect(state.requests.used).toBe(1); expect(state.tokens.used).toBe(60); expect(state.tokens.reserved).toBe(0); expect(state.tokens.remaining).toBe(940);
  });
  it('returns queued tokens but holds uncertain dispatched work for reconciliation', async () => {
    const u = await createUser(), r = await reserve(u);
    await dispatchAllowance(u.id, 'CHAT', r.resourceId); await finish(r);
    expect((await getAllowance(u.id)).tokens.reserved).toBe(500);
    expect((await prisma.aiAllowanceReservation.findUnique({ where: { id: r.id } })).state).toBe('UNCERTAIN');
    await finish(r, { usage: { inputTokens: 30, outputTokens: 10 } });
    expect((await getAllowance(u.id)).tokens.remaining).toBe(960);
  });
  it('releases a known preflight failure without restoring its consumed request allowance', async () => {
    const u = await createUser(), r = await reserve(u);
    await dispatchAllowance(u.id, 'CHAT', r.resourceId); await finish(r, { notDispatched: true });
    expect((await getAllowance(u.id))).toMatchObject({ requests: { used: 1 }, tokens: { reserved: 0, used: 0, remaining: 1000 } });
  });
  it('prevents concurrent reservations from overdrawing the same user', async () => {
    const u = await createUser();
    const results = await Promise.allSettled([reserve(u), reserve(u), reserve(u)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect((await getAllowance(u.id)).tokens.reserved).toBe(1000);
  });
  it('keeps spend and the active reset boundary when the administrator edits its schedule', async () => {
    const u = await createUser(), r = await reserve(u); await finish(r, { usage: { inputTokens: 80, outputTokens: 20 } });
    const before = await getAllowance(u.id); const policy = await allowancePolicy();
    await prisma.aiAllowancePolicy.update({ where: { id: 'global' }, data: { settings: { ...policy.settings, timeZone: 'Africa/Lagos', resetTime: '09:30', tokenResetCadence: 'MONTHLY', personalTokenAllowance: 1200 } } });
    const after = await getAllowance(u.id);
    expect(after.tokens.used).toBe(100); expect(after.tokens.remaining).toBe(1100); expect(after.tokens.resetsAt).toEqual(before.tokens.resetsAt);
  });
  it('renews an expired period once without rolling unused tokens forward', async () => {
    const u = await createUser(); const now = new Date('2026-10-20T12:00:00Z');
    const first = await tx((db) => allowanceSnapshot(db, u.id, { now }));
    const next = await tx((db) => allowanceSnapshot(db, u.id, { now: new Date('2026-10-21T12:00:00Z') }));
    const same = await tx((db) => allowanceSnapshot(db, u.id, { now: new Date('2026-10-21T13:00:00Z') }));
    expect(next.tokenWindowId).not.toBe(first.tokenWindowId); expect(same.tokenWindowId).toBe(next.tokenWindowId); expect(next.tokens.allocated).toBe(1000);
  });
  it('calculates Lagos midnight, monthly boundaries and daylight-saving transitions on the database clock', async () => {
    const s = (await allowancePolicy()).settings;
    const lagos = await allowanceBoundaries(prisma, { ...s, timeZone: 'Africa/Lagos' }, new Date('2026-10-20T00:01:00Z'));
    expect(lagos.requestStart.toISOString()).toBe('2026-10-19T23:00:00.000Z');
    const monthly = await allowanceBoundaries(prisma, { ...s, tokenResetCadence: 'MONTHLY', monthlyResetDay: 15 }, new Date('2026-10-10T12:00:00Z'));
    expect(monthly.tokenStart.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    const dst = await allowanceBoundaries(prisma, { ...s, timeZone: 'America/New_York' }, new Date('2026-11-01T12:00:00Z'));
    expect(dst.requestEnd - dst.requestStart).toBe(25 * 3600000);
  });
  it('keeps an append-only ledger, including after a new account read or login', async () => {
    const u = await createUser(), r = await reserve(u); await finish(r, { usage: { inputTokens: 1, outputTokens: 1 } });
    const entry = await prisma.aiAllowanceLedger.findFirst({ where: { userId: u.id } });
    await expect(prisma.aiAllowanceLedger.delete({ where: { id: entry.id } })).rejects.toThrow();
    await expect(prisma.aiAllowanceLedger.update({ where: { id: entry.id }, data: { usedDelta: 999 } })).rejects.toThrow();
    expect((await getAllowance(u.id)).tokens.used).toBe(2);
  });
  it('deduplicates low-balance notifications per period', async () => {
    const u = await createUser(), first = await reserve(u); await finish(first, { usage: { inputTokens: 750, outputTokens: 100 } });
    const second = await reserve(u); await finish(second, { usage: { inputTokens: 10, outputTokens: 10 } });
    expect(await prisma.notification.count({ where: { userId: u.id, title: 'Sabi AI tokens running low' } })).toBe(1);
  });
  it('restricts operations, validates values and rejects stale policy edits', async () => {
    const user = await createUser(); const policy = await allowancePolicy();
    expect((await post('/policy', { expectedVersion: policy.version, settings: policy.settings, reason: 'Synthetic settings check' }, user)).status).toBe(403);
    expect((await post('/policy', { expectedVersion: policy.version, settings: { ...policy.settings, personalDailyRequests: -1 }, reason: 'Synthetic settings check' })).status).toBe(400);
    expect((await post('/policy', { expectedVersion: policy.version, settings: policy.settings, reason: 'Synthetic settings check' })).status).toBe(200);
    expect((await post('/policy', { expectedVersion: policy.version, settings: policy.settings, reason: 'Synthetic stale check' })).status).toBe(409);
  });
  it('audits per-user overrides and makes bonus adjustments retry-safe', async () => {
    const u = await createUser(), balance = await getAllowance(u.id);
    expect((await post(`/users/${u.id}/override`, { expectedVersion: balance.accountVersion, dailyRequests: 1, tokenAllowance: 2000, reason: 'Synthetic individual allocation' })).status).toBe(200);
    const updated = await getAllowance(u.id);
    const payload = { expectedVersion: updated.accountVersion, clientRequestId: randomUUID(), deltaTokens: 400, reason: 'Synthetic current period bonus' };
    expect((await post(`/users/${u.id}/adjust`, payload)).status).toBe(200);
    expect((await post(`/users/${u.id}/adjust`, payload)).status).toBe(200);
    expect((await getAllowance(u.id)).tokens.allocated).toBe(2400);
    expect(await prisma.auditEvent.count({ where: { subjectUserId: u.id, resourceType: 'ai-allowance-account' } })).toBe(2);
  });
  it('enforces an explicit zero override without falling back to a default allowance', async () => {
    const u = await createUser(); await getAllowance(u.id);
    await prisma.aiAllowanceAccount.update({ where: { userId: u.id }, data: { dailyRequestOverride: 0 } });
    await expect(reserve(u)).rejects.toMatchObject({ code: 'AI_USER_QUOTA' });
    await prisma.aiAllowanceAccount.update({ where: { userId: u.id }, data: { dailyRequestOverride: null, tokenAllowanceOverride: 0 } });
    await expect(reserve(u)).rejects.toMatchObject({ code: 'AI_TOKEN_QUOTA' });
    expect((await getAllowance(u.id)).requests.used).toBe(0);
  });
  it('checks both service safeguards without debiting a denied request', async () => {
    const u = await createUser(); const policy = await allowancePolicy();
    for (const settings of [{ ...policy.settings, globalDailyRequests: 0 }, { ...policy.settings, globalTotalRequests: 0 }]) {
      await prisma.aiAllowancePolicy.update({ where: { id: 'global' }, data: { settings } });
      await expect(reserve(u)).rejects.toMatchObject({ code: 'AI_SERVICE_QUOTA' });
    }
    expect((await getAllowance(u.id)).requests.used).toBe(0);
  });
  it('applies professional defaults only from a server-verified professional profile', async () => {
    const u = await createUser(), policy = await allowancePolicy();
    await prisma.aiAllowancePolicy.update({ where: { id: 'global' }, data: { settings: { ...policy.settings, professionalTokenAllowance: 2000 } } });
    const profile = await prisma.professionalProfile.create({ data: { userId: u.id, professionType: 'DOCTOR', registrationNumber: `SYN-${randomUUID()}` } });
    expect((await getAllowance(u.id))).toMatchObject({ plan: 'PERSONAL', tokens: { allocated: 1000 } });
    await prisma.professionalProfile.update({ where: { id: profile.id }, data: { verificationStatus: 'VERIFIED' } });
    expect((await getAllowance(u.id))).toMatchObject({ plan: 'PROFESSIONAL', tokens: { allocated: 2000 } });
  });
  it('imports known pre-ledger provider usage once and does not reset it on another read', async () => {
    const u = await createUser(); const session = await prisma.aiSession.create({ data: { ownerUserId: u.id, title: 'Synthetic legacy', consentVersion: 'synthetic' } });
    await prisma.aiRun.create({ data: { sessionId: session.id, clientMessageId: randomUUID(), requestHash: 'synthetic', model: 'synthetic', promptVersion: 'synthetic', status: 'SUCCEEDED', usage: { inputTokens: 31, outputTokens: 5 } } });
    expect((await getAllowance(u.id))).toMatchObject({ requests: { used: 1 }, tokens: { used: 36, remaining: 964 } });
    await prisma.aiSession.update({ where: { id: session.id }, data: { archivedAt: new Date() } });
    expect((await getAllowance(u.id)).tokens.used).toBe(36);
  });
  it('enforces same-owner period references even for direct database writes', async () => {
    const u = await createUser(), other = await createUser(), reservation = await reserve(u);
    await expect(prisma.aiAllowanceLedger.create({ data: { userId: other.id, windowId: reservation.tokenWindowId, eventKey: randomUUID(), type: 'FORGED' } })).rejects.toMatchObject({ code: 'P2003' });
    await expect(prisma.aiAllowanceReservation.create({ data: { userId: other.id, resourceKind: 'CHAT', resourceId: randomUUID(), tokenWindowId: reservation.tokenWindowId, requestWindowId: reservation.requestWindowId, reservedTokens: 100, maxOutputTokens: 100 } })).rejects.toMatchObject({ code: 'P2003' });
  });
  it('settles a delayed result in its original period without consuming a renewed allocation', async () => {
    const u = await createUser(), r = await reserve(u); await dispatchAllowance(u.id, 'CHAT', r.resourceId);
    const now = Date.now();
    await prisma.aiAllowanceWindow.update({ where: { id: r.tokenWindowId }, data: { startsAt: new Date(now - 3 * 86400000), endsAt: new Date(now - 2 * 86400000) } });
    expect((await getAllowance(u.id)).tokens.remaining).toBe(1000);
    await finish(r, { usage: { inputTokens: 100, outputTokens: 50 } });
    expect((await getAllowance(u.id)).tokens.remaining).toBe(1000);
    expect((await prisma.aiAllowanceWindow.findUnique({ where: { id: r.tokenWindowId } })).usedUnits).toBe(150);
  });
  it('reconciles uncertain work once and audits the provider evidence reference', async () => {
    const u = await createUser(), r = await reserve(u); await dispatchAllowance(u.id, 'CHAT', r.resourceId); await finish(r);
    const body = { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, proofReference: 'synthetic-provider-log-42', reason: 'Reconcile verified synthetic provider log' };
    expect((await post(`/reservations/${r.id}/reconcile`, body)).status).toBe(200);
    expect((await post(`/reservations/${r.id}/reconcile`, body)).status).toBe(409);
    expect((await getAllowance(u.id)).tokens.remaining).toBe(985);
    expect(await prisma.auditEvent.count({ where: { resourceId: r.id, resourceType: 'ai-allowance-reservation' } })).toBe(1);
  });
});
