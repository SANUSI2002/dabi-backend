// Equipment intelligence (SCADA): the monitored-equipment register, device keys, device ingest, the
// timeline and alarms. See migration 20261127090000_emr_scada_core.
//
// Rules enforced here:
//   - readings, heartbeats and device events come only from a device key (POST /scada/ingest); nothing
//     is simulated, and equipment without a key reports "integration not configured";
//   - each reading is judged against its category's thresholds on the server; a Warning or Critical
//     reading raises one alarm per equipment and parameter (kept, never duplicated, while it is open);
//   - the timeline is append-only and a re-delivered device event (same idempotency key) is kept once;
//   - a device key is shown once when issued, stored as a SHA-256 hash, and can be revoked;
//   - moving equipment records where it was and where it went on the timeline;
//   - alarm lifecycle: Raised → Acknowledged / Investigating (equipment.report) → Escalated → Resolved,
//     Closed or Suppressed (equipment.manage); every step goes on the timeline with who did it.
import crypto from 'node:crypto';
import prisma from '../../../config/db.js';
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { updateVersioned } from '../core/concurrency.js';
import { EmrError } from '../core/errors.js';
import { userNameMap } from '../core/people.js';
import { nextSequence } from '../core/sequence.js';
import { approvedEmrFor, emrPatientRegistryEnabled } from '../emr.entitlement.js';
import { TELEMETRY_PARAMS, severityFor, thresholdCrossed } from './scada.params.js';

const org = (context) => ({ organizationId: context.organizationId });
const notFound = () => new EmrError('NOT_FOUND', { message: 'Equipment not found.' });
const OPEN = ['Raised', 'Acknowledged', 'Investigating', 'Escalated'];
const PREFIX = {
  'Laboratory Analyzer': 'LAB', 'Radiology Imaging': 'RAD', 'ICU Device': 'ICU', 'Theatre Equipment': 'THR', 'Dialysis Equipment': 'DLY', 'Pharmacy Cold Chain': 'CLD',
  Generator: 'GEN', HVAC: 'HVC', 'Medical Gas': 'GAS', 'Water Treatment': 'WTR', 'Solar / Inverter': 'SOL', Elevator: 'ELV', 'Other Infrastructure': 'INF',
};
// How stale a heartbeat may be before the equipment counts as degraded, stale, offline (the screens' rule).
const HEARTBEAT = { onlineMaxSec: 30, degradedMaxSec: 60, staleMaxSec: 120 };
const connectivity = (at, now = Date.now()) => {
  if (!at) return 'Unknown';
  const age = (now - at.getTime()) / 1000;
  return age <= HEARTBEAT.onlineMaxSec ? 'Online' : age <= HEARTBEAT.degradedMaxSec ? 'Degraded' : age <= HEARTBEAT.staleMaxSec ? 'Stale' : 'Offline';
};
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const correlation = () => crypto.randomUUID();

async function equipmentOf(tx, context, id) {
  const e = await tx.emrScadaEquipment.findFirst({ where: { ...org(context), id } });
  if (!e) throw notFound();
  return e;
}
async function logEvent(tx, context, equipmentId, { type, source, actor, detail, at = new Date(), idempotencyKey = crypto.randomUUID(), correlationId = correlation(), patientId, relatedOrderId }) {
  // the same event delivered again is kept once (checked first: a failed insert would abort the transaction)
  if (await tx.emrScadaEvent.findFirst({ where: { ...org(context), equipmentId, idempotencyKey }, select: { id: true } })) return null;
  return tx.emrScadaEvent.create({
    data: { ...org(context), equipmentId, type, at, source, actor: actor ?? null, detail: detail?.slice(0, 1000) ?? null, idempotencyKey, correlationId, patientId: patientId ?? null, relatedOrderId: relatedOrderId ?? null },
  });
}
const nameOf = async (tx, context) => (await userNameMap(tx, [context.userId])).get(context.userId) ?? 'Staff member';

// ---- reading ----------------------------------------------------------------------------------------
export async function overview(context) {
  return withTenant(context, async (tx) => {
    const [equipment, keys, alarms, events] = await Promise.all([
      tx.emrScadaEquipment.findMany({ where: org(context), orderBy: { tag: 'asc' } }),
      tx.emrScadaDeviceKey.findMany({ where: { ...org(context), revokedAt: null }, select: { equipmentId: true } }),
      tx.emrScadaAlarm.findMany({ where: { ...org(context), OR: [{ status: { in: OPEN } }, { raisedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }] }, orderBy: { raisedAt: 'desc' }, take: 300 }),
      tx.emrScadaEvent.findMany({ where: org(context), orderBy: { at: 'desc' }, take: 100 }),
    ]);
    // the latest reading of each parameter of each equipment
    const latest = equipment.length ? await tx.$queryRaw`
      SELECT DISTINCT ON ("equipment_id", "parameter") "equipment_id" AS "equipmentId", "parameter", "value", "severity", "recorded_at" AS "recordedAt"
      FROM "emr_scada_readings" WHERE "organization_id" = ${context.organizationId}
      ORDER BY "equipment_id", "parameter", "recorded_at" DESC` : [];
    const names = await userNameMap(tx, [...equipment.map((e) => e.registeredByUserId), ...alarms.flatMap((a) => [a.acknowledgedByUserId, a.resolvedByUserId])]);
    const who = (id) => (id ? names.get(id) ?? 'Former member' : undefined);
    const connected = new Set(keys.map((k) => k.equipmentId));
    const now = Date.now();
    await recordAudit(tx, context, { action: 'scada.viewed', resourceType: 'scada' });
    return {
      equipment: equipment.map((e) => ({
        id: e.id, equipmentId: e.tag, linkedAssetId: e.assetId ?? undefined, name: e.name, category: e.category, manufacturer: e.manufacturer, model: e.model, serialNumber: e.serialNumber,
        ownership: e.ownership, location: e.location, procurement: e.procurement, lifecycle: e.lifecycle, compliance: e.compliance,
        technical: { ...e.technical, integrationKind: connected.has(e.id) ? 'REAL_DEVICE' : 'NOT_CONFIGURED' },
        machineState: e.decommissionedAt ? 'Decommissioned' : e.machineState, connectivity: connected.has(e.id) ? connectivity(e.lastHeartbeatAt, now) : 'Unknown',
        lastHeartbeatAt: e.lastHeartbeatAt, latencyMs: e.lastLatencyMs, createdAt: e.createdAt, registeredBy: who(e.registeredByUserId), version: e.version,
        readings: latest.filter((r) => r.equipmentId === e.id).map((r) => ({ key: r.parameter, value: r.value, severity: r.severity, at: r.recordedAt })),
      })),
      alarms: alarms.map((a) => presentAlarm(a, who)),
      events: events.map(presentEvent),
    };
  });
}
const presentAlarm = (a, who) => ({
  id: a.id, equipmentId: a.equipmentId, raisedAt: a.raisedAt, source: a.source, severity: a.severity, category: a.category, description: a.description,
  parameter: a.parameter ?? undefined, value: a.value ?? undefined, threshold: a.threshold ?? undefined, status: a.status,
  acknowledgedBy: who(a.acknowledgedByUserId), acknowledgedAt: a.acknowledgedAt ?? undefined, investigationNote: a.investigationNote ?? undefined,
  escalatedTo: a.escalatedTo ?? undefined, escalatedAt: a.escalatedAt ?? undefined, resolution: a.resolution ?? undefined, resolvedBy: who(a.resolvedByUserId), resolvedAt: a.resolvedAt ?? undefined, version: a.version,
});
const presentEvent = (e) => ({
  id: e.id, equipmentId: e.equipmentId, type: e.type, at: e.at, source: e.source, actor: e.actor ?? undefined, detail: e.detail ?? undefined,
  patientId: e.patientId ?? undefined, relatedOrderId: e.relatedOrderId ?? undefined, correlationId: e.correlationId, idempotencyKey: e.idempotencyKey,
});

export async function equipmentDetail(context, id, { parameter, hours }) {
  return withTenant(context, async (tx) => {
    const e = await equipmentOf(tx, context, id);
    const since = new Date(Date.now() - hours * 3_600_000);
    const [events, readings, keys] = await Promise.all([
      tx.emrScadaEvent.findMany({ where: { ...org(context), equipmentId: id }, orderBy: { at: 'desc' }, take: 300 }),
      tx.emrScadaReading.findMany({ where: { ...org(context), equipmentId: id, recordedAt: { gte: since }, ...(parameter ? { parameter } : {}) }, orderBy: { recordedAt: 'asc' }, take: 2000 }),
      tx.emrScadaDeviceKey.findMany({ where: { ...org(context), equipmentId: id }, orderBy: { createdAt: 'desc' } }),
    ]);
    const names = await userNameMap(tx, keys.flatMap((k) => [k.createdByUserId, k.revokedByUserId]));
    const history = {};
    for (const r of readings) (history[r.parameter] ??= []).push({ at: r.recordedAt, value: r.value });
    return {
      id: e.id, timeline: events.map(presentEvent), history,
      // never the secret: only which keys exist and whether they are in use
      deviceKeys: keys.map((k) => ({ id: k.id, label: k.label, createdAt: k.createdAt, createdBy: names.get(k.createdByUserId) ?? 'Former member', lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt })),
    };
  });
}

// ---- register ---------------------------------------------------------------------------------------
export async function registerEquipment(context, input) {
  return withTenant(context, async (tx) => {
    if (input.assetId && !(await tx.emrAsset.findFirst({ where: { ...org(context), id: input.assetId } }))) throw new EmrError('NOT_FOUND', { message: 'Asset not found.' });
    const tag = `EQ-${PREFIX[input.category]}-${String(await nextSequence(tx, context, `scada_${PREFIX[input.category]}`)).padStart(4, '0')}`;
    const { technical = {}, ...rest } = input;
    const e = await tx.emrScadaEquipment.create({
      data: {
        ...(input.id ? { id: input.id } : {}), ...org(context), tag, assetId: rest.assetId ?? null, name: rest.name, category: rest.category, manufacturer: rest.manufacturer ?? '', model: rest.model ?? '',
        serialNumber: rest.serialNumber ?? '', ownership: rest.ownership ?? 'Owned', location: rest.location, procurement: rest.procurement ?? {}, lifecycle: rest.lifecycle ?? {},
        technical: { firmwareVersion: technical.firmwareVersion, ipAddress: technical.ipAddress, gateway: technical.gateway, protocol: technical.protocol },
        compliance: rest.compliance ?? { calibrationRequired: false }, registeredByUserId: context.userId,
      },
    });
    await logEvent(tx, context, e.id, { type: 'REGISTERED', source: 'USER', actor: await nameOf(tx, context), detail: `Registered as ${tag}` });
    await recordAudit(tx, context, { action: 'scada.equipment.registered', resourceType: 'scada_equipment', resourceId: e.id });
    return { id: e.id, equipmentId: tag };
  });
}
export async function updateEquipment(context, id, expectedVersion, patch) {
  return withTenant(context, async (tx) => {
    const e = await equipmentOf(tx, context, id);
    if (e.decommissionedAt) throw new EmrError('INVALID_STATE', { message: 'This equipment has been decommissioned.' });
    const { reason, ...changes } = patch;
    const data = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    if (data.technical) data.technical = { ...e.technical, ...data.technical };
    await updateVersioned(tx.emrScadaEquipment, { organizationId: context.organizationId, id, expectedVersion, data, notFoundCode: 'NOT_FOUND' });
    if (data.location) {
      const where = (l) => [l.building, l.floor, l.department, l.ward, l.room].filter(Boolean).join(' · ');
      await logEvent(tx, context, id, { type: 'LOCATION_CHANGED', source: 'USER', actor: await nameOf(tx, context), detail: `${where(e.location)} → ${where(data.location)}${reason ? ` (${reason})` : ''}` });
    }
    await recordAudit(tx, context, { action: 'scada.equipment.updated', resourceType: 'scada_equipment', resourceId: id, changedFields: Object.keys(data) });
    return { id };
  });
}
export async function decommission(context, id, { reason }) {
  return withTenant(context, async (tx) => {
    const e = await equipmentOf(tx, context, id);
    if (e.decommissionedAt) throw new EmrError('INVALID_STATE', { message: 'Already decommissioned.' });
    await updateVersioned(tx.emrScadaEquipment, { organizationId: context.organizationId, id, expectedVersion: e.version, data: { decommissionedAt: new Date(), machineState: 'Decommissioned' }, notFoundCode: 'NOT_FOUND' });
    // its devices stop being able to report
    await tx.emrScadaDeviceKey.updateMany({ where: { ...org(context), equipmentId: id, revokedAt: null }, data: { revokedAt: new Date(), revokedByUserId: context.userId } });
    await logEvent(tx, context, id, { type: 'DECOMMISSIONED', source: 'USER', actor: await nameOf(tx, context), detail: reason });
    await recordAudit(tx, context, { action: 'scada.equipment.decommissioned', resourceType: 'scada_equipment', resourceId: id });
    return { id };
  });
}

// ---- device keys ------------------------------------------------------------------------------------
export async function issueDeviceKey(context, equipmentId, { label }) {
  return withTenant(context, async (tx) => {
    const e = await equipmentOf(tx, context, equipmentId);
    if (e.decommissionedAt) throw new EmrError('INVALID_STATE', { message: 'This equipment has been decommissioned.' });
    const secret = crypto.randomBytes(32).toString('base64url');
    const key = await tx.emrScadaDeviceKey.create({ data: { ...org(context), equipmentId, label, secretHash: sha256(secret), createdByUserId: context.userId } });
    await logEvent(tx, context, equipmentId, { type: 'CONNECTION_RESTORED', source: 'USER', actor: await nameOf(tx, context), detail: `Device key "${label}" issued` });
    await recordAudit(tx, context, { action: 'scada.device_key.issued', resourceType: 'scada_device_key', resourceId: key.id });
    // shown this once; only its hash is kept
    return { id: key.id, label, key: `sdk.${context.organizationId}.${key.id}.${secret}` };
  });
}
export async function revokeDeviceKey(context, equipmentId, keyId) {
  return withTenant(context, async (tx) => {
    const { count } = await tx.emrScadaDeviceKey.updateMany({ where: { ...org(context), id: keyId, equipmentId, revokedAt: null }, data: { revokedAt: new Date(), revokedByUserId: context.userId } });
    if (!count) throw new EmrError('NOT_FOUND', { message: 'No active key with that id.' });
    await logEvent(tx, context, equipmentId, { type: 'CONNECTION_LOST', source: 'USER', actor: await nameOf(tx, context), detail: 'Device key revoked' });
    await recordAudit(tx, context, { action: 'scada.device_key.revoked', resourceType: 'scada_device_key', resourceId: keyId });
    return { id: keyId };
  });
}

// ---- alarms -----------------------------------------------------------------------------------------
async function raiseInTx(tx, context, equipmentId, { actor, ...input }) {
  // already open for this cause: keep it, with the latest value (the open-alarm index is the backstop)
  const open = input.dedupKey ? await tx.emrScadaAlarm.findFirst({ where: { ...org(context), dedupKey: input.dedupKey, status: { in: OPEN } } }) : null;
  if (open) {
    if (input.value !== undefined) await tx.emrScadaAlarm.updateMany({ where: { ...org(context), id: open.id }, data: { value: input.value } });
    return { alarm: open, created: false };
  }
  const a = await tx.emrScadaAlarm.create({ data: { ...org(context), equipmentId, ...input } });
  await logEvent(tx, context, equipmentId, { type: 'ALARM_RAISED', source: input.source, actor, detail: `${input.severity}: ${input.description}` });
  return { alarm: a, created: true };
}
export async function raiseAlarm(context, equipmentId, { severity, category, description }) {
  return withTenant(context, async (tx) => {
    await equipmentOf(tx, context, equipmentId);
    const { alarm } = await raiseInTx(tx, context, equipmentId, { source: 'USER', severity, category, description, actor: await nameOf(tx, context) });
    return { id: alarm.id };
  });
}
const STEP = {
  acknowledge: { from: ['Raised'], to: 'Acknowledged', event: 'ALARM_ACKNOWLEDGED' },
  investigate: { from: ['Raised', 'Acknowledged', 'Escalated'], to: 'Investigating', event: 'ALARM_ACKNOWLEDGED' },
  escalate: { from: ['Raised', 'Acknowledged', 'Investigating'], to: 'Escalated', event: 'ALARM_ACKNOWLEDGED' },
  resolve: { from: OPEN, to: 'Resolved', event: 'ALARM_RESOLVED' },
  close: { from: ['Resolved'], to: 'Closed', event: 'ALARM_RESOLVED' },
  suppress: { from: OPEN, to: 'Suppressed', event: 'ALARM_RESOLVED' },
};
export async function stepAlarm(context, alarmId, expectedVersion, action, { note, to, resolution } = {}) {
  return withTenant(context, async (tx) => {
    const a = await tx.emrScadaAlarm.findFirst({ where: { ...org(context), id: alarmId } });
    if (!a) throw new EmrError('NOT_FOUND', { message: 'Alarm not found.' });
    const step = STEP[action];
    if (!step.from.includes(a.status)) throw new EmrError('INVALID_STATE', { message: `A ${a.status.toLowerCase()} alarm cannot be ${step.to.toLowerCase()}.` });
    const now = new Date();
    const data = {
      status: step.to,
      ...(action === 'acknowledge' || (action === 'investigate' && !a.acknowledgedAt) ? { acknowledgedByUserId: context.userId, acknowledgedAt: now } : {}),
      ...(action === 'investigate' ? { investigationNote: note } : {}),
      ...(action === 'escalate' ? { escalatedTo: to, escalatedAt: now } : {}),
      ...(action === 'resolve' || action === 'suppress' ? { resolution: resolution ?? note ?? (action === 'suppress' ? 'Suppressed' : null), resolvedByUserId: context.userId, resolvedAt: now } : {}),
    };
    await updateVersioned(tx.emrScadaAlarm, { organizationId: context.organizationId, id: alarmId, expectedVersion, data, notFoundCode: 'NOT_FOUND' });
    await logEvent(tx, context, a.equipmentId, { type: step.event, source: 'USER', actor: await nameOf(tx, context), detail: `${a.category} alarm ${step.to.toLowerCase()}${to ? ` to ${to}` : ''}${note || resolution ? `: ${note ?? resolution}` : ''}` });
    await recordAudit(tx, context, { action: `scada.alarm.${action}`, resourceType: 'scada_alarm', resourceId: alarmId });
    return { id: alarmId, status: step.to };
  });
}

// ---- device ingest ----------------------------------------------------------------------------------
const KEY = /^sdk\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
/** Authenticates a device key; returns the tenant context and the key/equipment it belongs to. */
export async function authenticateDevice(header) {
  const m = KEY.exec(String(header ?? '').replace(/^Device\s+/i, '').trim());
  if (!m) throw new EmrError('AUTHENTICATION_REQUIRED', { message: 'A valid device key is required.' });
  const [, organizationId, keyId, secret] = m;
  // the organization must hold an approved EMR package, like any signed-in request
  const identity = await prisma.identityOrganization.findUnique({ where: { id: organizationId }, select: { type: true, organisationId: true } });
  if (!identity || !emrPatientRegistryEnabled() || !(await approvedEmrFor({ organization: { facilityId: identity.organisationId, type: identity.type } }))) {
    throw new EmrError('AUTHENTICATION_REQUIRED', { message: 'A valid device key is required.' });
  }
  const context = { organizationId, userId: null, requestId: null };
  const key = await withTenant(context, (tx) => tx.emrScadaDeviceKey.findFirst({ where: { organizationId, id: keyId } }));
  const expected = Buffer.from(key?.secretHash ?? '0'.repeat(64), 'hex');
  const ok = crypto.timingSafeEqual(Buffer.from(sha256(secret), 'hex'), expected) && key && !key.revokedAt;
  if (!ok) throw new EmrError('AUTHENTICATION_REQUIRED', { message: 'A valid device key is required.' });
  return { context, key };
}

const ALARM_FOR = { Warning: 'Medium', Critical: 'High' };
export async function ingest(header, input) {
  const { context, key } = await authenticateDevice(header);
  return withTenant(context, async (tx) => {
    const e = await equipmentOf(tx, context, key.equipmentId);
    if (e.decommissionedAt) throw new EmrError('INVALID_STATE', { message: 'This equipment has been decommissioned.' });
    const now = new Date();
    const actor = `Device: ${key.label}`;
    const defs = TELEMETRY_PARAMS[e.category];
    const accepted = { readings: 0, events: 0, alarms: 0 };
    const unknown = (input.readings ?? []).filter((r) => !defs.some((d) => d.key === r.parameter)).map((r) => r.parameter);
    if (unknown.length) throw new EmrError('VALIDATION_FAILED', { message: `Not a ${e.category} parameter: ${[...new Set(unknown)].join(', ')}. Expected one of ${defs.map((d) => d.key).join(', ')}.` });

    // came back after being away: say so on the timeline
    if (connectivity(e.lastHeartbeatAt, now.getTime()) === 'Offline') await logEvent(tx, context, e.id, { type: 'CONNECTION_RESTORED', source: 'DEVICE_GATEWAY', actor });
    const data = { lastHeartbeatAt: now, ...(input.heartbeat?.latencyMs !== undefined ? { lastLatencyMs: input.heartbeat.latencyMs } : {}), ...(input.machineState ? { machineState: input.machineState } : {}) };
    await tx.emrScadaEquipment.updateMany({ where: { ...org(context), id: e.id }, data: { ...data, version: { increment: 1 } } });
    await tx.emrScadaDeviceKey.updateMany({ where: { ...org(context), id: key.id }, data: { lastUsedAt: now } });

    for (const r of input.readings ?? []) {
      const def = defs.find((d) => d.key === r.parameter);
      const severity = severityFor(def, r.value);
      const at = r.at ? new Date(r.at) : now;
      await tx.emrScadaReading.create({ data: { ...org(context), equipmentId: e.id, parameter: r.parameter, value: r.value, severity, recordedAt: at, deviceKeyId: key.id } });
      accepted.readings += 1;
      if (severity !== 'Normal') {
        const threshold = thresholdCrossed(def, r.value);
        const { created } = await raiseInTx(tx, context, e.id, {
          source: 'DEVICE_GATEWAY', severity: ALARM_FOR[severity], category: 'Threshold Breach', parameter: r.parameter, value: r.value, threshold, dedupKey: `${e.id}:threshold:${r.parameter}`, actor,
          description: `${def.label} ${r.value}${def.unit ? ` ${def.unit}` : ''} is ${severity.toLowerCase()} (threshold ${threshold}${def.unit ? ` ${def.unit}` : ''})`,
        });
        if (created) accepted.alarms += 1;
      }
    }
    for (const ev of input.events ?? []) {
      const row = await logEvent(tx, context, e.id, { type: ev.type, source: 'DEVICE_GATEWAY', actor, detail: ev.detail, at: ev.at ? new Date(ev.at) : now, idempotencyKey: ev.idempotencyKey, correlationId: ev.correlationId ?? correlation() });
      if (row) accepted.events += 1;
    }
    return { equipmentId: e.tag, ...accepted, receivedAt: now };
  });
}
