// Equipment & maintenance. The asset register carries each asset's preventive-maintenance interval and
// last service date (the next due date is derived, never stored). A high-priority fault takes an
// in-service asset under repair; resolving its last open job returns it to service and stamps today
// as the service date. Logging a preventive service resets the PM clock and closes the open PM job.
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { updateVersioned } from '../core/concurrency.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { userNameMap } from '../core/people.js';

export const ASSET_CATEGORIES = ['Cold chain', 'Maternity', 'Diagnostics', 'Power', 'IT', 'General'];
const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : null);
const toDate = (iso) => new Date(`${iso}T00:00:00.000Z`);
const todayIso = () => new Date().toISOString().slice(0, 10);

const presentAsset = (a) => ({
  id: a.id, tag: a.tag, name: a.name, category: a.category, location: a.location, status: a.status, serialNumber: a.serialNumber,
  costMinor: a.costMinor === null ? null : Number(a.costMinor), commissionedOn: isoDay(a.commissionedOn), serviceIntervalDays: a.serviceIntervalDays,
  lastServicedOn: isoDay(a.lastServicedOn), version: a.version, createdAt: a.createdAt,
});

export async function listEquipment(context) {
  return withTenant(context, async (tx) => {
    const [assets, jobs] = await Promise.all([
      tx.emrAsset.findMany({ where: { organizationId: context.organizationId }, orderBy: { name: 'asc' } }),
      tx.emrMaintenanceJob.findMany({ where: { organizationId: context.organizationId }, orderBy: { openedAt: 'desc' }, take: 1000 }),
    ]);
    const names = await userNameMap(tx, jobs.flatMap((j) => [j.reportedByUserId, j.resolvedByUserId]));
    await recordAudit(tx, context, { action: 'equipment.listed', resourceType: 'asset' });
    return {
      assets: assets.map(presentAsset),
      jobs: jobs.map((j) => ({
        id: j.id, assetId: j.assetId, type: j.type, summary: j.summary, priority: j.priority, status: j.status, version: j.version,
        reportedByName: names.get(j.reportedByUserId) ?? null, openedAt: j.openedAt, startedAt: j.startedAt, closedAt: j.closedAt,
        resolution: j.resolution, resolvedByName: j.resolvedByUserId ? names.get(j.resolvedByUserId) ?? null : null,
      })),
    };
  });
}

export async function addAsset(context, input, { idempotencyKey } = {}) {
  if (input.lastServicedOn < input.commissionedOn) throw new EmrError('VALIDATION_FAILED', { message: 'The last service cannot be before the asset was commissioned.' });
  if (input.lastServicedOn > todayIso() || input.commissionedOn > todayIso()) throw new EmrError('VALIDATION_FAILED', { message: 'Commissioning and service dates cannot be in the future.' });
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'asset.add', body: input }, async () => {
    let asset;
    try {
      asset = await tx.emrAsset.create({
        data: {
          organizationId: context.organizationId, tag: input.tag, name: input.name, category: input.category, location: input.location,
          serialNumber: input.serialNumber ?? null, costMinor: input.costMinor === undefined ? null : BigInt(input.costMinor),
          commissionedOn: toDate(input.commissionedOn), serviceIntervalDays: input.serviceIntervalDays, lastServicedOn: toDate(input.lastServicedOn),
          ...(input.status ? { status: input.status } : {}),
        },
      });
    } catch (error) {
      throw uniqueViolation(error, { tag: 'ASSET_TAG_IN_USE' }) ?? error;
    }
    await recordAudit(tx, context, { action: 'asset.added', resourceType: 'asset', resourceId: asset.id });
    return { statusCode: 201, body: presentAsset(asset) };
  }));
}

export async function setAssetStatus(context, assetId, expectedVersion, { status }) {
  return withTenant(context, async (tx) => {
    const asset = await updateVersioned(tx.emrAsset, { organizationId: context.organizationId, id: assetId, expectedVersion, data: { status }, notFoundCode: 'ASSET_NOT_FOUND' });
    await recordAudit(tx, context, { action: 'asset.status_changed', resourceType: 'asset', resourceId: assetId, changedFields: [status] });
    return presentAsset(asset);
  });
}

async function loadAsset(tx, context, assetId) {
  const rows = await tx.$queryRaw`SELECT "id" FROM "emr_assets" WHERE "organization_id" = ${context.organizationId} AND "id" = ${assetId} FOR UPDATE`;
  if (!rows.length) throw new EmrError('ASSET_NOT_FOUND');
  return tx.emrAsset.findFirst({ where: { organizationId: context.organizationId, id: assetId } });
}

export async function reportFault(context, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'asset.fault', body: input }, async () => {
    const asset = await loadAsset(tx, context, input.assetId);
    if (asset.status === 'RETIRED') throw new EmrError('INVALID_STATE', { message: 'This asset is retired.' });
    const job = await tx.emrMaintenanceJob.create({
      data: { organizationId: context.organizationId, assetId: asset.id, type: 'CORRECTIVE', summary: input.summary, priority: input.priority, reportedByUserId: context.userId },
    });
    if (input.priority === 'HIGH' && asset.status === 'IN_SERVICE') {
      await tx.emrAsset.updateMany({ where: { organizationId: context.organizationId, id: asset.id }, data: { status: 'UNDER_REPAIR', version: { increment: 1 } } });
    }
    await recordAudit(tx, context, { action: 'asset.fault_reported', resourceType: 'asset', resourceId: asset.id });
    return { statusCode: 201, body: { jobId: job.id } };
  }));
}

export async function startJob(context, jobId, expectedVersion) {
  return withTenant(context, async (tx) => {
    const job = await tx.emrMaintenanceJob.findFirst({ where: { organizationId: context.organizationId, id: jobId } });
    if (!job) throw new EmrError('MAINTENANCE_JOB_NOT_FOUND');
    if (job.status !== 'OPEN') throw new EmrError('INVALID_STATE', { message: 'Only an open job can be started.' });
    await updateVersioned(tx.emrMaintenanceJob, { organizationId: context.organizationId, id: jobId, expectedVersion, data: { status: 'IN_PROGRESS', startedAt: new Date() }, notFoundCode: 'MAINTENANCE_JOB_NOT_FOUND' });
    await recordAudit(tx, context, { action: 'maintenance_job.started', resourceType: 'maintenance_job', resourceId: jobId });
    return { jobId, status: 'IN_PROGRESS' };
  });
}

async function afterResolving(tx, context, asset) {
  const stillOpen = await tx.emrMaintenanceJob.count({ where: { organizationId: context.organizationId, assetId: asset.id, status: { not: 'RESOLVED' } } });
  await tx.emrAsset.updateMany({
    where: { organizationId: context.organizationId, id: asset.id },
    data: { lastServicedOn: toDate(todayIso()), ...(!stillOpen && asset.status === 'UNDER_REPAIR' ? { status: 'IN_SERVICE' } : {}), version: { increment: 1 } },
  });
}

export async function resolveJob(context, jobId, expectedVersion, { resolution }) {
  return withTenant(context, async (tx) => {
    const job = await tx.emrMaintenanceJob.findFirst({ where: { organizationId: context.organizationId, id: jobId } });
    if (!job) throw new EmrError('MAINTENANCE_JOB_NOT_FOUND');
    const asset = await loadAsset(tx, context, job.assetId);
    if (job.status === 'RESOLVED') throw new EmrError('INVALID_STATE', { message: 'This job is already resolved.' });
    await updateVersioned(tx.emrMaintenanceJob, {
      organizationId: context.organizationId, id: jobId, expectedVersion, notFoundCode: 'MAINTENANCE_JOB_NOT_FOUND',
      data: { status: 'RESOLVED', closedAt: new Date(), resolution, resolvedByUserId: context.userId },
    });
    await afterResolving(tx, context, asset);
    await recordAudit(tx, context, { action: 'maintenance_job.resolved', resourceType: 'maintenance_job', resourceId: jobId });
    return { jobId, status: 'RESOLVED' };
  });
}

export async function schedulePm(context, assetId) {
  return withTenant(context, async (tx) => {
    const asset = await loadAsset(tx, context, assetId);
    if (asset.status === 'RETIRED') throw new EmrError('INVALID_STATE', { message: 'This asset is retired.' });
    let job;
    try {
      job = await tx.emrMaintenanceJob.create({
        data: { organizationId: context.organizationId, assetId, type: 'PREVENTIVE', summary: `Scheduled service — ${asset.name}`, priority: 'LOW', reportedByUserId: context.userId },
      });
    } catch (error) {
      throw uniqueViolation(error, { one_open_pm: 'PM_ALREADY_OPEN' }) ?? error;
    }
    await recordAudit(tx, context, { action: 'asset.pm_scheduled', resourceType: 'asset', resourceId: assetId });
    return { jobId: job.id };
  });
}

/** Records a preventive service: closes the open PM job (or records one) and resets the PM clock. */
export async function logService(context, assetId, { note }) {
  return withTenant(context, async (tx) => {
    const asset = await loadAsset(tx, context, assetId);
    if (asset.status === 'RETIRED') throw new EmrError('INVALID_STATE', { message: 'This asset is retired.' });
    const summary = note || 'Routine preventive service';
    const now = new Date();
    const open = await tx.emrMaintenanceJob.findFirst({ where: { organizationId: context.organizationId, assetId, type: 'PREVENTIVE', status: { not: 'RESOLVED' } } });
    if (open) {
      await tx.emrMaintenanceJob.updateMany({ where: { organizationId: context.organizationId, id: open.id }, data: { status: 'RESOLVED', closedAt: now, resolution: summary, resolvedByUserId: context.userId, version: { increment: 1 } } });
    } else {
      await tx.emrMaintenanceJob.create({
        data: { organizationId: context.organizationId, assetId, type: 'PREVENTIVE', summary, priority: 'LOW', status: 'RESOLVED', reportedByUserId: context.userId, closedAt: now, resolution: summary, resolvedByUserId: context.userId },
      });
    }
    await tx.emrAsset.updateMany({
      where: { organizationId: context.organizationId, id: assetId },
      data: { lastServicedOn: toDate(todayIso()), ...(asset.status === 'OUT_OF_SERVICE' ? { status: 'IN_SERVICE' } : {}), version: { increment: 1 } },
    });
    await recordAudit(tx, context, { action: 'asset.serviced', resourceType: 'asset', resourceId: assetId });
    return { assetId, lastServicedOn: todayIso() };
  });
}
