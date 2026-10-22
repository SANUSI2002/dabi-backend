// Community outreach. Each activity names the CHW who carried it out (an active member who holds
// outreach.chw) and is logged by that CHW or a supervising nurse. Entries are never edited; a mistaken
// one is marked entered in error and drops out of the totals.
import { requireListed } from '../../org-config/orgConfig.service.js';
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { EmrError } from '../core/errors.js';
import { activeMemberWithPermission } from '../core/membership.js';
import { userNameMap } from '../core/people.js';

// The starter Outreach Activity Types (Settings → Master Data).
export const OUTREACH_TYPES = ['Household visit', 'Health talk', 'Immunization campaign', 'Defaulter tracing', 'Community screening'];
const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : null);

async function present(tx, rows) {
  const names = await userNameMap(tx, rows.flatMap((a) => [a.chwUserId, a.recordedByUserId]));
  return rows.map((a) => ({
    id: a.id, chwUserId: a.chwUserId, chwName: names.get(a.chwUserId) ?? null, activityType: a.activityType, ward: a.ward, households: a.households,
    referrals: a.referrals, activityDate: isoDay(a.activityDate), notes: a.notes, status: a.status, recordedByName: names.get(a.recordedByUserId) ?? null,
    enteredInErrorReason: a.enteredInErrorReason, createdAt: a.createdAt,
  }));
}

export async function listActivities(context, { includeEnteredInError, limit }) {
  return withTenant(context, async (tx) => {
    const rows = await tx.emrOutreachActivity.findMany({
      where: { organizationId: context.organizationId, ...(includeEnteredInError ? {} : { status: 'ACTIVE' }) },
      orderBy: [{ activityDate: 'desc' }, { createdAt: 'desc' }], take: limit,
    });
    await recordAudit(tx, context, { action: 'outreach.listed', resourceType: 'outreach_activity' });
    return { items: await present(tx, rows) };
  });
}

export async function logActivity(context, input, { idempotencyKey } = {}) {
  if (!(await activeMemberWithPermission(context.organizationId, input.chwUserId, 'outreach.chw'))) {
    throw new EmrError('VALIDATION_FAILED', { message: 'Choose an active community health worker of this organization.' });
  }
  if (input.activityDate > new Date().toISOString().slice(0, 10)) throw new EmrError('VALIDATION_FAILED', { message: 'The activity date cannot be in the future.' });
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'outreach.log', body: input }, async () => {
    await requireListed(tx, context, 'outreach-activity-types', input.activityType, { what: 'The activity type' });
    const row = await tx.emrOutreachActivity.create({
      data: {
        organizationId: context.organizationId, chwUserId: input.chwUserId, activityType: input.activityType, ward: input.ward, households: input.households,
        referrals: input.referrals, activityDate: new Date(`${input.activityDate}T00:00:00.000Z`), notes: input.notes ?? null, recordedByUserId: context.userId,
      },
    });
    await recordAudit(tx, context, { action: 'outreach.logged', resourceType: 'outreach_activity', resourceId: row.id });
    await enqueueEvent(tx, context, { type: 'outreach.logged', aggregateType: 'outreach_activity', aggregateId: row.id, data: { activityType: row.activityType, households: row.households, referrals: row.referrals } });
    return { statusCode: 201, body: (await present(tx, [row]))[0] };
  }));
}

export async function markActivityInError(context, activityId, { reason }) {
  return withTenant(context, async (tx) => {
    const activity = await tx.emrOutreachActivity.findFirst({ where: { organizationId: context.organizationId, id: activityId } });
    if (!activity) throw new EmrError('OUTREACH_ACTIVITY_NOT_FOUND');
    if (activity.status !== 'ACTIVE') throw new EmrError('INVALID_STATE', { message: 'This entry is already marked entered in error.' });
    const { count } = await tx.emrOutreachActivity.updateMany({
      where: { organizationId: context.organizationId, id: activity.id, status: 'ACTIVE' },
      data: { status: 'ENTERED_IN_ERROR', enteredInErrorReason: reason, enteredInErrorByUserId: context.userId, enteredInErrorAt: new Date() },
    });
    if (count !== 1) throw new EmrError('INVALID_STATE', { message: 'This entry is already marked entered in error.' });
    await recordAudit(tx, context, { action: 'outreach.entered_in_error', resourceType: 'outreach_activity', resourceId: activity.id });
    return (await present(tx, [await tx.emrOutreachActivity.findFirst({ where: { organizationId: context.organizationId, id: activity.id } })]))[0];
  });
}
