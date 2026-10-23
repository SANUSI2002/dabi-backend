// Looking after monitored equipment: maintenance work orders, calibrations, consumables, warranty and
// claims, and usage sessions. See migration 20261128090000_emr_scada_care.
//
// Rules enforced here:
//   - a work order moves Requested → Scheduled → In Progress ⇄ Awaiting Parts → Testing → Completed (or
//     Cancelled); it completes only with a passed return-to-service test, and completing it resolves the
//     equipment's open maintenance alarm;
//   - a calibration completes with a result; a pass needs a certificate number and resolves the open
//     calibration alarm;
//   - overdue maintenance and calibration raise one alarm per cause (checked whenever the command centre
//     loads; never duplicated);
//   - consumables are tracked only once registered; a device's TEST_STARTED uses one unit of the usable
//     lot that expires first; low stock, expired or exhausted lots raise one alarm each;
//   - acting on equipment needs equipment.manage (raising a corrective work order: equipment.report).
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { updateVersioned } from '../core/concurrency.js';
import { EmrError } from '../core/errors.js';
import { userNameMap } from '../core/people.js';
import { nextSequence } from '../core/sequence.js';
import { OPEN, equipmentOf, logEvent, nameOf, raiseInTx } from './scada.service.js';

const org = (context) => ({ organizationId: context.organizationId });
const DAY = 86_400_000;
const iso = (d) => (d ? d.toISOString() : undefined);
const num = (d) => (d === null || d === undefined ? undefined : Number(d));
const CHECKLISTS = {
  'Laboratory Analyzer': ['Reagent system', 'Sample probe', 'Waste system', 'Calibration check', 'QC run', 'Cleaning'],
  'Radiology Imaging': ['Tube warm-up', 'Detector check', 'Collimator alignment', 'Radiation safety check', 'Image quality test'],
  'ICU Device': ['Pressure/leak test', 'Oxygen sensor', 'Battery', 'Alarm test', 'Flow sensor', 'Filter replacement'],
  'Theatre Equipment': ['Output calibration', 'Electrical safety test', 'Grounding check', 'Alarm test'],
  'Dialysis Equipment': ['Conductivity check', 'Pressure test', 'Disinfection cycle', 'Water quality check', 'Alarm test'],
  'Pharmacy Cold Chain': ['Door seal check', 'Temperature log review', 'Compressor check', 'Alarm test', 'Backup power check'],
  Generator: ['Fuel', 'Oil', 'Battery', 'Voltage/frequency', 'Cooling system', 'Leak check', 'Load test'],
  HVAC: ['Filter replacement', 'Refrigerant level', 'Compressor check', 'Ductwork inspection', 'Thermostat calibration'],
  'Medical Gas': ['Pressure test', 'Leak check', 'Alarm panel test', 'Manifold inspection', 'Tank level check'],
  'Water Treatment': ['Filter replacement', 'Pressure check', 'Water quality test', 'Pump inspection'],
  'Solar / Inverter': ['Panel cleaning', 'Battery check', 'Inverter output test', 'Wiring inspection'],
  Elevator: ['Door mechanism', 'Cable inspection', 'Safety brake test', 'Emergency phone test'],
  'Other Infrastructure': ['General inspection', 'Safety check'],
};
// Work-order status moves the screen offers.
const NEXT = {
  Requested: ['Scheduled', 'In Progress', 'Cancelled'], Scheduled: ['In Progress', 'Cancelled'], 'In Progress': ['Awaiting Parts', 'Testing', 'Cancelled'],
  'Awaiting Parts': ['In Progress', 'Cancelled'], Testing: ['In Progress', 'Completed'], Completed: [], Cancelled: [],
};

/** Resolves an equipment's open alarms of one category, with a note pointing at what closed them. */
async function resolveOpen(tx, context, equipmentId, category, resolution) {
  const open = await tx.emrScadaAlarm.findMany({ where: { ...org(context), equipmentId, category, status: { in: OPEN } } });
  for (const a of open) {
    await tx.emrScadaAlarm.updateMany({ where: { ...org(context), id: a.id }, data: { status: 'Resolved', resolution, resolvedByUserId: context.userId, resolvedAt: new Date(), version: { increment: 1 } } });
  }
  if (open.length) await logEvent(tx, context, equipmentId, { type: 'ALARM_RESOLVED', source: 'SYSTEM', actor: 'Sabi', detail: `${open.length} ${category.toLowerCase()} alarm(s) resolved: ${resolution}` });
}

// ---- what is due --------------------------------------------------------------------------------------
/** When maintenance and calibration are next due, from the equipment's own history. */
export async function dueDates(tx, context, e) {
  const [lastPm, lastCal] = await Promise.all([
    tx.emrScadaWorkOrder.findFirst({ where: { ...org(context), equipmentId: e.id, type: 'Preventive', status: 'Completed' }, orderBy: { completedAt: 'desc' } }),
    tx.emrScadaCalibration.findFirst({ where: { ...org(context), equipmentId: e.id, status: 'Completed', result: 'Pass' }, orderBy: { performedAt: 'desc' } }),
  ]);
  const since = new Date(e.lifecycle?.commissioningDate ?? e.lifecycle?.installationDate ?? e.createdAt);
  const pmEvery = e.compliance?.preventiveMaintenanceIntervalDays;
  const calEvery = e.compliance?.calibrationIntervalDays;
  return {
    maintenanceDue: pmEvery ? new Date((lastPm?.completedAt ?? since).getTime() + pmEvery * DAY) : null,
    calibrationDue: e.compliance?.calibrationRequired
      ? (lastCal?.certificateExpiry ?? (calEvery ? new Date((lastCal?.performedAt ?? since).getTime() + calEvery * DAY) : null))
      : null,
  };
}
/** Raises (once each) the alarms for overdue maintenance, calibration and consumables. */
export async function sweepDue(tx, context) {
  const now = Date.now();
  const equipment = await tx.emrScadaEquipment.findMany({ where: { ...org(context), decommissionedAt: null } });
  for (const e of equipment) {
    const due = await dueDates(tx, context, e);
    if (due.maintenanceDue && due.maintenanceDue.getTime() < now) {
      await raiseInTx(tx, context, e.id, { source: 'SYSTEM', actor: 'Sabi', severity: 'Medium', category: 'Maintenance', dedupKey: `${e.id}:maintenance`, description: `Preventive maintenance overdue since ${due.maintenanceDue.toISOString().slice(0, 10)}` });
    }
    if (due.calibrationDue && due.calibrationDue.getTime() < now) {
      await raiseInTx(tx, context, e.id, { source: 'SYSTEM', actor: 'Sabi', severity: 'High', category: 'Calibration', dedupKey: `${e.id}:calibration`, description: `Calibration overdue since ${due.calibrationDue.toISOString().slice(0, 10)}` });
    }
  }
  const items = await tx.emrScadaConsumable.findMany({ where: org(context) });
  for (const c of items) {
    const expired = c.expiryDate.getTime() < now;
    const state = expired ? 'expired' : c.quantityOnHand <= 0 ? 'out of stock' : c.quantityOnHand <= c.reorderThreshold ? 'low on stock' : null;
    if (state) {
      await raiseInTx(tx, context, c.equipmentId, {
        source: 'SYSTEM', actor: 'Sabi', severity: state === 'low on stock' ? 'Medium' : 'High', category: 'Consumable', dedupKey: `${c.id}:${state}`,
        description: `${c.name} (lot ${c.lotNumber}) is ${state}${state === 'low on stock' ? ` — ${c.quantityOnHand} ${c.unit} left` : ''}`,
      });
    }
  }
}

// ---- reading ----------------------------------------------------------------------------------------
export async function careOverview(context) {
  return withTenant(context, async (tx) => {
    await sweepDue(tx, context);
    const [orders, calibrations, consumables, usage, warranties, claims, sessions] = await Promise.all([
      tx.emrScadaWorkOrder.findMany({ where: org(context), orderBy: { reportedAt: 'desc' }, take: 500 }),
      tx.emrScadaCalibration.findMany({ where: org(context), orderBy: { scheduledFor: 'desc' }, take: 500 }),
      tx.emrScadaConsumable.findMany({ where: org(context), orderBy: { expiryDate: 'asc' } }),
      tx.emrScadaConsumableUsage.findMany({ where: org(context), orderBy: { at: 'desc' }, take: 500 }),
      tx.emrScadaWarranty.findMany({ where: org(context) }),
      tx.emrScadaWarrantyClaim.findMany({ where: org(context), orderBy: { raisedAt: 'desc' } }),
      tx.emrScadaUsageSession.findMany({ where: org(context), orderBy: { startedAt: 'desc' }, take: 500 }),
    ]);
    const equipment = await tx.emrScadaEquipment.findMany({ where: org(context) });
    const due = Object.fromEntries(await Promise.all(equipment.map(async (e) => [e.id, await dueDates(tx, context, e)])));
    const names = await userNameMap(tx, [...orders.map((o) => o.reportedByUserId), ...calibrations.map((c) => c.requestedByUserId), ...consumables.map((c) => c.registeredByUserId),
      ...warranties.map((w) => w.updatedByUserId), ...claims.map((c) => c.raisedByUserId)]);
    const who = (id) => names.get(id) ?? 'Former member';
    return {
      due: Object.fromEntries(Object.entries(due).map(([id, d]) => [id, { maintenanceDue: iso(d.maintenanceDue), calibrationDue: iso(d.calibrationDue) }])),
      workOrders: orders.map((o) => ({
        id: o.id, number: o.number, equipmentId: o.equipmentId, type: o.type, status: o.status, severity: o.severity, reportedAt: iso(o.reportedAt), reportedBy: who(o.reportedByUserId),
        failureCategory: o.failureCategory ?? undefined, description: o.description, scheduledFor: iso(o.scheduledFor), technician: o.technician ?? undefined, checklist: o.checklist,
        startedAt: iso(o.startedAt), diagnosis: o.diagnosis ?? undefined, correctiveAction: o.correctiveAction ?? undefined, partsUsed: o.partsUsed, laborCost: num(o.laborCost),
        completedAt: iso(o.completedAt), downtimeMinutes: o.downtimeMinutes ?? undefined, returnToServiceTested: o.returnToServiceTested, returnToServiceNote: o.returnToServiceNote ?? undefined,
        cancelReason: o.cancelReason ?? undefined, version: o.version,
      })),
      calibrations: calibrations.map((c) => ({
        id: c.id, equipmentId: c.equipmentId, status: c.status, scheduledFor: iso(c.scheduledFor), requestedAt: iso(c.requestedAt), requestedBy: who(c.requestedByUserId), technician: c.technician ?? undefined,
        vendor: c.vendor ?? undefined, standardsUsed: c.standardsUsed ?? undefined, performedAt: iso(c.performedAt), result: c.result ?? undefined, certificateNumber: c.certificateNumber ?? undefined,
        certificateExpiry: iso(c.certificateExpiry), notes: c.notes ?? undefined, cancelReason: c.cancelReason ?? undefined, version: c.version,
      })),
      consumables: consumables.map((c) => ({
        id: c.id, equipmentId: c.equipmentId, name: c.name, lotNumber: c.lotNumber, expiryDate: iso(c.expiryDate), unit: c.unit, quantityOnHand: c.quantityOnHand, reorderThreshold: c.reorderThreshold,
        costPerUnit: Number(c.costPerUnit), supplier: c.supplier ?? undefined, registeredAt: iso(c.registeredAt), registeredBy: who(c.registeredByUserId), version: c.version,
      })),
      consumableUsage: usage.map((u) => ({ id: u.id, equipmentId: u.equipmentId, consumableId: u.consumableId, quantityUsed: u.quantityUsed, reason: u.reason, at: iso(u.at), source: u.source, testName: u.testName ?? undefined, orderId: u.orderId ?? undefined })),
      warranties: warranties.map((w) => ({ equipmentId: w.equipmentId, provider: w.provider, start: iso(w.start), end: iso(w.end), coverage: w.coverage, contactName: w.contactName ?? undefined, contactPhone: w.contactPhone ?? undefined, slaHours: w.slaHours ?? undefined, updatedAt: iso(w.updatedAt), updatedBy: who(w.updatedByUserId) })),
      claims: claims.map((c) => ({
        id: c.id, equipmentId: c.equipmentId, claimNumber: c.claimNumber ?? undefined, issue: c.issue, status: c.status, raisedAt: iso(c.raisedAt), raisedBy: who(c.raisedByUserId),
        relatedWorkOrderId: c.relatedWorkOrderId ?? undefined, repairedUnderWarranty: c.repairedUnderWarranty ?? undefined, costRecovered: num(c.costRecovered), resolvedAt: iso(c.resolvedAt), resolutionNote: c.resolutionNote ?? undefined, version: c.version,
      })),
      usageSessions: sessions.map((s) => ({ id: s.id, equipmentId: s.equipmentId, operator: s.operator, patientId: s.patientId ?? undefined, testName: s.testName ?? undefined, orderId: s.orderId ?? undefined, startedAt: iso(s.startedAt), endedAt: iso(s.endedAt), outcome: s.outcome ?? undefined })),
    };
  });
}

// ---- work orders ------------------------------------------------------------------------------------
export async function createWorkOrder(context, equipmentId, input) {
  return withTenant(context, async (tx) => {
    const e = await equipmentOf(tx, context, equipmentId);
    if (e.decommissionedAt) throw new EmrError('INVALID_STATE', { message: 'This equipment has been decommissioned.' });
    const number = `WO-${new Date().getUTCFullYear()}-${String(await nextSequence(tx, context, `scada_wo_${new Date().getUTCFullYear()}`)).padStart(5, '0')}`;
    const wo = await tx.emrScadaWorkOrder.create({
      data: {
        ...(input.id ? { id: input.id } : {}), ...org(context), equipmentId, number, type: input.type, severity: input.severity, description: input.description, failureCategory: input.failureCategory ?? null,
        scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null, technician: input.technician ?? null, status: input.scheduledFor ? 'Scheduled' : 'Requested',
        checklist: (CHECKLISTS[e.category] ?? []).map((label, i) => ({ id: String(i), label, done: false })), reportedByUserId: context.userId,
      },
    });
    await logEvent(tx, context, equipmentId, { type: input.type === 'Preventive' ? 'MAINTENANCE_STARTED' : 'WARNING', source: 'USER', actor: await nameOf(tx, context), detail: `${number}: ${input.type} — ${input.description}` });
    await recordAudit(tx, context, { action: 'scada.work_order.created', resourceType: 'scada_work_order', resourceId: wo.id });
    return { id: wo.id, number };
  });
}
export async function updateWorkOrder(context, id, expectedVersion, patch) {
  return withTenant(context, async (tx) => {
    const wo = await tx.emrScadaWorkOrder.findFirst({ where: { ...org(context), id } });
    if (!wo) throw new EmrError('NOT_FOUND', { message: 'Work order not found.' });
    if (['Completed', 'Cancelled'].includes(wo.status)) throw new EmrError('INVALID_STATE', { message: `This work order is ${wo.status.toLowerCase()}.` });
    const { status, ...fields } = patch;
    if (status && !NEXT[wo.status].includes(status)) throw new EmrError('INVALID_STATE', { message: `A work order cannot go from ${wo.status} to ${status}.` });
    const tested = fields.returnToServiceTested ?? wo.returnToServiceTested;
    if (status === 'Completed' && !tested) throw new EmrError('VALIDATION_FAILED', { message: 'Record a passed return-to-service test before completing.' });
    if (status === 'Cancelled' && !fields.cancelReason) throw new EmrError('VALIDATION_FAILED', { message: 'Give a reason for cancelling.' });
    const now = new Date();
    const data = Object.fromEntries(Object.entries({
      ...fields, scheduledFor: fields.scheduledFor ? new Date(fields.scheduledFor) : undefined, status,
      ...(status === 'In Progress' && !wo.startedAt ? { startedAt: now } : {}), ...(status === 'Completed' ? { completedAt: now } : {}),
    }).filter(([, v]) => v !== undefined));
    await updateVersioned(tx.emrScadaWorkOrder, { organizationId: context.organizationId, id, expectedVersion, data, notFoundCode: 'NOT_FOUND' });
    if (status) {
      const actor = await nameOf(tx, context);
      await logEvent(tx, context, wo.equipmentId, { type: status === 'Completed' ? 'MAINTENANCE_COMPLETED' : status === 'In Progress' ? 'MAINTENANCE_STARTED' : 'WARNING', source: 'USER', actor, detail: `${wo.number} ${status.toLowerCase()}${fields.cancelReason ? `: ${fields.cancelReason}` : ''}` });
      if (status === 'Completed') {
        await resolveOpen(tx, context, wo.equipmentId, 'Maintenance', `${wo.number} completed and tested`);
        if (wo.type !== 'Preventive') await logEvent(tx, context, wo.equipmentId, { type: 'REPAIRED', source: 'USER', actor, detail: fields.correctiveAction ?? wo.correctiveAction ?? wo.description });
      }
    }
    await recordAudit(tx, context, { action: `scada.work_order.${status ? status.toLowerCase().replace(/ /g, '_') : 'updated'}`, resourceType: 'scada_work_order', resourceId: id, changedFields: Object.keys(data) });
    return { id, status: status ?? wo.status };
  });
}

// ---- calibration ------------------------------------------------------------------------------------
export async function scheduleCalibration(context, equipmentId, input) {
  return withTenant(context, async (tx) => {
    await equipmentOf(tx, context, equipmentId);
    const c = await tx.emrScadaCalibration.create({ data: { ...(input.id ? { id: input.id } : {}), ...org(context), equipmentId, scheduledFor: new Date(input.scheduledFor), technician: input.technician ?? null, vendor: input.vendor ?? null, requestedByUserId: context.userId } });
    await recordAudit(tx, context, { action: 'scada.calibration.scheduled', resourceType: 'scada_calibration', resourceId: c.id });
    return { id: c.id };
  });
}
export async function updateCalibration(context, id, expectedVersion, patch) {
  return withTenant(context, async (tx) => {
    const c = await tx.emrScadaCalibration.findFirst({ where: { ...org(context), id } });
    if (!c) throw new EmrError('NOT_FOUND', { message: 'Calibration not found.' });
    if (['Completed', 'Cancelled'].includes(c.status)) throw new EmrError('INVALID_STATE', { message: `This calibration is ${c.status.toLowerCase()}.` });
    const { status, ...fields } = patch;
    if (status === 'Completed' && !fields.result) throw new EmrError('VALIDATION_FAILED', { message: 'Record the result.' });
    if (fields.result === 'Pass' && !fields.certificateNumber) throw new EmrError('VALIDATION_FAILED', { message: 'A passed calibration needs its certificate number.' });
    if (status === 'Cancelled' && !fields.cancelReason) throw new EmrError('VALIDATION_FAILED', { message: 'Give a reason for cancelling.' });
    const data = Object.fromEntries(Object.entries({
      ...fields, status, certificateExpiry: fields.certificateExpiry ? new Date(fields.certificateExpiry) : undefined, scheduledFor: fields.scheduledFor ? new Date(fields.scheduledFor) : undefined,
      ...(status === 'Completed' ? { performedAt: new Date() } : {}),
    }).filter(([, v]) => v !== undefined));
    await updateVersioned(tx.emrScadaCalibration, { organizationId: context.organizationId, id, expectedVersion, data, notFoundCode: 'NOT_FOUND' });
    if (status === 'In Progress' || status === 'Completed') {
      await logEvent(tx, context, c.equipmentId, { type: status === 'Completed' ? 'CALIBRATION_COMPLETED' : 'CALIBRATION_STARTED', source: 'USER', actor: await nameOf(tx, context), detail: status === 'Completed' ? `${fields.result}${fields.certificateNumber ? ` — certificate ${fields.certificateNumber}` : ''}` : undefined });
    }
    if (status === 'Completed' && fields.result === 'Pass') await resolveOpen(tx, context, c.equipmentId, 'Calibration', `Calibration passed — certificate ${fields.certificateNumber}`);
    if (status === 'Completed' && fields.result === 'Fail') {
      await raiseInTx(tx, context, c.equipmentId, { source: 'USER', actor: await nameOf(tx, context), severity: 'High', category: 'Calibration', dedupKey: `${c.equipmentId}:calibration`, description: `Calibration failed${fields.notes ? `: ${fields.notes}` : ''}` });
    }
    await recordAudit(tx, context, { action: `scada.calibration.${status ? status.toLowerCase().replace(/ /g, '_') : 'updated'}`, resourceType: 'scada_calibration', resourceId: id });
    return { id, status: status ?? c.status };
  });
}

// ---- consumables ------------------------------------------------------------------------------------
export async function registerConsumable(context, equipmentId, input) {
  return withTenant(context, async (tx) => {
    await equipmentOf(tx, context, equipmentId);
    const { id, expiryDate, ...fields } = input;
    const c = await tx.emrScadaConsumable.create({ data: { ...(id ? { id } : {}), ...org(context), equipmentId, ...fields, expiryDate: new Date(expiryDate), registeredByUserId: context.userId } });
    await recordAudit(tx, context, { action: 'scada.consumable.registered', resourceType: 'scada_consumable', resourceId: c.id });
    return { id: c.id };
  });
}
export async function adjustConsumable(context, id, expectedVersion, { quantityDelta, reason }) {
  return withTenant(context, async (tx) => {
    const c = await tx.emrScadaConsumable.findFirst({ where: { ...org(context), id } });
    if (!c) throw new EmrError('NOT_FOUND', { message: 'Consumable not found.' });
    const qty = c.quantityOnHand + quantityDelta;
    if (qty < 0) throw new EmrError('VALIDATION_FAILED', { message: `Only ${c.quantityOnHand} ${c.unit} on hand.` });
    await updateVersioned(tx.emrScadaConsumable, { organizationId: context.organizationId, id, expectedVersion, data: { quantityOnHand: qty }, notFoundCode: 'NOT_FOUND' });
    if (quantityDelta < 0) await tx.emrScadaConsumableUsage.create({ data: { ...org(context), equipmentId: c.equipmentId, consumableId: id, quantityUsed: -quantityDelta, reason, source: 'USER', byUserId: context.userId } });
    // restocked: the low/out-of-stock alarms for this lot are no longer true
    if (quantityDelta > 0 && qty > c.reorderThreshold) {
      for (const state of ['low on stock', 'out of stock']) {
        await tx.emrScadaAlarm.updateMany({ where: { ...org(context), dedupKey: `${id}:${state}`, status: { in: OPEN } }, data: { status: 'Resolved', resolution: `Restocked to ${qty} ${c.unit}`, resolvedByUserId: context.userId, resolvedAt: new Date(), version: { increment: 1 } } });
      }
    }
    await recordAudit(tx, context, { action: 'scada.consumable.adjusted', resourceType: 'scada_consumable', resourceId: id, changedFields: [String(quantityDelta)] });
    return { id, quantityOnHand: qty };
  });
}
/** A device started a test: one unit of the usable lot that expires first (if this equipment's consumables are tracked). */
export async function useForTest(tx, context, equipmentId, { testName, orderId }) {
  const items = await tx.emrScadaConsumable.findMany({ where: { ...org(context), equipmentId }, orderBy: { expiryDate: 'asc' } });
  if (!items.length) return null; // not tracked for this equipment
  const usable = items.find((c) => c.quantityOnHand > 0 && c.expiryDate.getTime() >= Date.now());
  if (!usable) {
    await raiseInTx(tx, context, equipmentId, { source: 'SYSTEM', actor: 'Sabi', severity: 'High', category: 'Consumable', dedupKey: `${equipmentId}:consumables-exhausted`, description: 'A test started with no usable consumables registered (all expired or out of stock)' });
    return null;
  }
  await tx.emrScadaConsumable.updateMany({ where: { ...org(context), id: usable.id }, data: { quantityOnHand: { decrement: 1 }, version: { increment: 1 } } });
  await tx.emrScadaConsumableUsage.create({ data: { ...org(context), equipmentId, consumableId: usable.id, quantityUsed: 1, reason: 'Test', source: 'DEVICE_GATEWAY', testName: testName ?? null, orderId: orderId ?? null } });
  return usable.id;
}

// ---- warranty ---------------------------------------------------------------------------------------
export async function setWarranty(context, equipmentId, input) {
  return withTenant(context, async (tx) => {
    await equipmentOf(tx, context, equipmentId);
    const data = { provider: input.provider, start: new Date(input.start), end: new Date(input.end), coverage: input.coverage, contactName: input.contactName ?? null, contactPhone: input.contactPhone ?? null, slaHours: input.slaHours ?? null, updatedByUserId: context.userId, updatedAt: new Date() };
    await tx.emrScadaWarranty.upsert({ where: { organizationId_equipmentId: { organizationId: context.organizationId, equipmentId } }, create: { ...org(context), equipmentId, ...data }, update: data });
    await recordAudit(tx, context, { action: 'scada.warranty.set', resourceType: 'scada_equipment', resourceId: equipmentId });
    return { equipmentId };
  });
}
export async function raiseClaim(context, equipmentId, input) {
  return withTenant(context, async (tx) => {
    await equipmentOf(tx, context, equipmentId);
    const w = await tx.emrScadaWarranty.findUnique({ where: { organizationId_equipmentId: { organizationId: context.organizationId, equipmentId } } });
    if (!w) throw new EmrError('INVALID_STATE', { message: 'Record the warranty before raising a claim.' });
    if (w.end.getTime() < Date.now()) throw new EmrError('INVALID_STATE', { message: 'The warranty has expired.' });
    if (input.relatedWorkOrderId && !(await tx.emrScadaWorkOrder.findFirst({ where: { ...org(context), id: input.relatedWorkOrderId, equipmentId } }))) throw new EmrError('NOT_FOUND', { message: 'Work order not found for this equipment.' });
    const c = await tx.emrScadaWarrantyClaim.create({ data: { ...(input.id ? { id: input.id } : {}), ...org(context), equipmentId, issue: input.issue, claimNumber: input.claimNumber ?? null, relatedWorkOrderId: input.relatedWorkOrderId ?? null, raisedByUserId: context.userId } });
    await recordAudit(tx, context, { action: 'scada.warranty_claim.raised', resourceType: 'scada_warranty_claim', resourceId: c.id });
    return { id: c.id };
  });
}
const CLAIM_NEXT = { Submitted: ['Approved', 'Rejected'], Approved: ['In Repair', 'Completed'], 'In Repair': ['Completed'], Rejected: [], Completed: [] };
export async function updateClaim(context, id, expectedVersion, patch) {
  return withTenant(context, async (tx) => {
    const c = await tx.emrScadaWarrantyClaim.findFirst({ where: { ...org(context), id } });
    if (!c) throw new EmrError('NOT_FOUND', { message: 'Claim not found.' });
    if (patch.status && !CLAIM_NEXT[c.status].includes(patch.status)) throw new EmrError('INVALID_STATE', { message: `A claim cannot go from ${c.status} to ${patch.status}.` });
    const done = ['Completed', 'Rejected'].includes(patch.status);
    const data = Object.fromEntries(Object.entries({ ...patch, ...(done ? { resolvedAt: new Date() } : {}) }).filter(([, v]) => v !== undefined));
    await updateVersioned(tx.emrScadaWarrantyClaim, { organizationId: context.organizationId, id, expectedVersion, data, notFoundCode: 'NOT_FOUND' });
    await recordAudit(tx, context, { action: 'scada.warranty_claim.updated', resourceType: 'scada_warranty_claim', resourceId: id, changedFields: Object.keys(data) });
    return { id, status: patch.status ?? c.status };
  });
}

// ---- usage, from device events ----------------------------------------------------------------------
/** TEST_STARTED opens a usage session (and uses a consumable); TEST_COMPLETED closes it. */
export async function trackUsage(tx, context, equipmentId, event, { actor }) {
  if (event.type === 'TEST_STARTED') {
    if (await tx.emrScadaUsageSession.findFirst({ where: { ...org(context), equipmentId, correlationId: event.correlationId } })) return;
    await tx.emrScadaUsageSession.create({
      data: { ...org(context), equipmentId, correlationId: event.correlationId, operator: (event.operator ?? actor).slice(0, 160), patientId: event.patientId ?? null, testName: event.testName ?? null, orderId: event.orderId ?? null, startedAt: event.at },
    });
    await useForTest(tx, context, equipmentId, { testName: event.testName, orderId: event.orderId });
  } else if (event.type === 'TEST_COMPLETED' || (event.type === 'ERROR' && event.correlationId)) {
    await tx.emrScadaUsageSession.updateMany({ where: { ...org(context), equipmentId, correlationId: event.correlationId, endedAt: null }, data: { endedAt: event.at, outcome: event.type === 'TEST_COMPLETED' ? 'Completed' : 'Aborted' } });
  }
}
