// Antenatal care. A pregnancy is enrolled once (one ongoing pregnancy per woman), visits are recorded
// against it, and it is closed when the woman delivers, transfers out, or the pregnancy ends.
//
// The server works out what must not be typed by hand: EDD (LMP + 280 days), gestational age at each
// visit (whole weeks since the LMP), and the risk flags shown to staff — anaemia (latest Hb < 10 g/dL),
// hypertension (any BP ≥ 140/90), maternal age under 18 or 35 and over, grand multiparity (parity ≥ 5),
// an abnormal fetal heart rate at the last visit, and a missed visit (the planned next visit has passed).
// Visits are never edited; a wrong one is marked entered-in-error. Booking blood results come from the
// laboratory module (orders since the LMP) and are shown only to staff who may read lab orders.
import { withTenant } from '../core/db.js';
import { afterCursor, page } from '../core/cursor.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { updateVersioned } from '../core/concurrency.js';
import { markEnteredInError } from '../core/entries.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { userNameMap } from '../core/people.js';
import { findPatient } from '../patients/patients.repository.js';

const DAY = 86_400_000;
const MAX_WEEKS = 45;
const toDate = (iso) => new Date(`${iso}T00:00:00.000Z`);
const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : null);
const today = (now = new Date()) => toDate(now.toISOString().slice(0, 10));
const number = (value) => (value === null || value === undefined ? null : Number(value));
export const weeksSince = (lmp, day) => Math.floor((day.getTime() - lmp.getTime()) / (7 * DAY));
const yearsBetween = (from, to) => {
  let years = to.getUTCFullYear() - from.getUTCFullYear();
  if (to.getUTCMonth() < from.getUTCMonth() || (to.getUTCMonth() === from.getUTCMonth() && to.getUTCDate() < from.getUTCDate())) years -= 1;
  return years;
};

const patientSummary = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true } };
const withVisits = { patient: patientSummary, visits: { orderBy: [{ visitDate: 'asc' }, { createdAt: 'asc' }] } };

/** Why staff should look twice at this pregnancy. Uses only visits that were not entered in error. */
export function riskFlags(pregnancy, now = new Date()) {
  const visits = pregnancy.visits.filter((v) => v.status === 'ACTIVE');
  const flags = [];
  const hbs = visits.filter((v) => v.hb !== null).map((v) => number(v.hb));
  const latestHb = hbs.length ? hbs.at(-1) : number(pregnancy.bookingHb);
  if (latestHb !== null && latestHb < 10) flags.push({ code: 'ANAEMIA', label: `Anaemia (Hb ${latestHb} g/dL)` });
  if (visits.some((v) => v.systolic !== null && (v.systolic >= 140 || v.diastolic >= 90))) flags.push({ code: 'HYPERTENSION', label: 'Blood pressure 140/90 or higher' });
  const dob = pregnancy.patient?.dateOfBirth;
  if (dob) {
    const age = yearsBetween(dob, pregnancy.lmp);
    if (age < 18) flags.push({ code: 'YOUNG_MOTHER', label: `Mother under 18 (${age})` });
    else if (age >= 35) flags.push({ code: 'OLDER_MOTHER', label: `Mother 35 or older (${age})` });
  }
  if (pregnancy.parity >= 5) flags.push({ code: 'GRAND_MULTIPARITY', label: `Grand multiparity (P${pregnancy.parity})` });
  const last = visits.at(-1);
  if (last?.fetalHeartRate !== null && last?.fetalHeartRate !== undefined && (last.fetalHeartRate < 110 || last.fetalHeartRate > 160)) {
    flags.push({ code: 'FETAL_HEART_RATE', label: `Fetal heart rate ${last.fetalHeartRate}/min at the last visit` });
  }
  if (pregnancy.status === 'ACTIVE' && last?.nextVisitDate && last.nextVisitDate < today(now)) flags.push({ code: 'MISSED_VISIT', label: `Missed visit due ${isoDay(last.nextVisitDate)}` });
  return flags;
}

/** Laboratory orders placed for each pregnancy's patient from its LMP (to closure), when the caller may read them. */
async function labsFor(tx, context, pregnancies) {
  if (!context.permissions.includes('lab.order.read') || !pregnancies.length) return null;
  const from = new Date(Math.min(...pregnancies.map((p) => p.lmp.getTime())));
  const orders = await tx.emrLabOrder.findMany({
    where: { organizationId: context.organizationId, patientId: { in: [...new Set(pregnancies.map((p) => p.patientId))] }, createdAt: { gte: from } },
    select: { id: true, patientId: true, createdAt: true, items: { select: { id: true, testName: true, status: true, results: { where: { status: { not: 'SUPERSEDED' } }, orderBy: { analyteCode: 'asc' }, select: { analyteName: true, valueNumeric: true, valueText: true, unit: true } } } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 500,
  });
  return (pregnancy) => orders
    .filter((o) => o.patientId === pregnancy.patientId && o.createdAt >= pregnancy.lmp && (!pregnancy.closedAt || o.createdAt <= pregnancy.closedAt))
    .flatMap((o) => o.items.map((item) => ({
      orderId: o.id, itemId: item.id, testName: item.testName, status: item.status, orderedAt: o.createdAt,
      result: item.results.map((r) => `${r.analyteName}: ${r.valueNumeric !== null ? Number(r.valueNumeric) : r.valueText ?? ''}${r.unit ? ` ${r.unit}` : ''}`).join('; ') || null,
    })));
}

async function present(tx, context, rows) {
  const names = await userNameMap(tx, rows.flatMap((p) => [p.enrolledByUserId, p.closedByUserId, ...p.visits.flatMap((v) => [v.recordedByUserId, v.erroredByUserId])]));
  const name = (id) => (id ? names.get(id) ?? null : null);
  const labs = await labsFor(tx, context, rows);
  const now = new Date();
  return rows.map((p) => ({
    id: p.id, patientId: p.patientId, version: p.version, status: p.status,
    patient: p.patient ? { ...p.patient, dateOfBirth: isoDay(p.patient.dateOfBirth) } : undefined,
    lmp: isoDay(p.lmp), edd: isoDay(p.edd), gravida: p.gravida, parity: p.parity, bloodGroup: p.bloodGroup, bookingHb: number(p.bookingHb), ttDoses: p.ttDoses,
    gestationalWeeksToday: p.status === 'ACTIVE' ? Math.min(weeksSince(p.lmp, today(now)), MAX_WEEKS) : null,
    enrolledByName: name(p.enrolledByUserId), createdAt: p.createdAt,
    closedAt: p.closedAt, closedByName: name(p.closedByUserId), closureNote: p.closureNote,
    riskFlags: riskFlags(p, now),
    visits: p.visits.map((v) => ({
      id: v.id, visitDate: isoDay(v.visitDate), gestationalWeeks: v.gestationalWeeks, weightKg: number(v.weightKg), systolic: v.systolic, diastolic: v.diastolic,
      hb: number(v.hb), fetalHeartRate: v.fetalHeartRate, nextVisitDate: isoDay(v.nextVisitDate), notes: v.notes, status: v.status,
      recordedByName: name(v.recordedByUserId), createdAt: v.createdAt, errorReason: v.errorReason, erroredByName: name(v.erroredByUserId),
    })),
    labs: labs ? labs(p) : null,
  }));
}

const loadFull = async (tx, context, id) => {
  const row = await tx.emrPregnancy.findFirst({ where: { organizationId: context.organizationId, id }, include: withVisits });
  if (!row) throw new EmrError('PREGNANCY_NOT_FOUND');
  return (await present(tx, context, [row]))[0];
};

async function done(tx, context, pregnancy, action, data = {}) {
  await recordAudit(tx, context, { action: `pregnancy.${action}`, resourceType: 'pregnancy', resourceId: pregnancy.id });
  await enqueueEvent(tx, context, { type: action === 'visit_recorded' ? 'anc.visit.recorded' : `pregnancy.${action}`, aggregateType: 'patient', aggregateId: pregnancy.patientId, data: { pregnancyId: pregnancy.id, ...data } });
  return loadFull(tx, context, pregnancy.id);
}

export async function listPregnancies(context, { status, patientId, cursor, limit }) {
  const after = afterCursor('createdAt', cursor, 'desc');
  return withTenant(context, async (tx) => {
    const rows = await tx.emrPregnancy.findMany({
      where: { organizationId: context.organizationId, ...(status ? { status: { in: status } } : {}), ...(patientId ? { patientId } : {}), ...after },
      include: withVisits,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    await recordAudit(tx, context, { action: 'pregnancy.listed', resourceType: 'pregnancy' });
    const result = page(rows, limit, 'createdAt');
    return { ...result, items: await present(tx, context, result.items) };
  });
}

export async function enrolPregnancy(context, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'pregnancy.enrol', body: input }, async () => {
    const patient = await findPatient(tx, context.organizationId, input.patientId, { id: true, status: true, sex: true });
    if (!patient) throw new EmrError('PATIENT_NOT_FOUND');
    if (patient.status !== 'ACTIVE') throw new EmrError('PATIENT_INACTIVE');
    if (patient.sex !== 'FEMALE') throw new EmrError('VALIDATION_FAILED', { message: 'Antenatal enrolment is for female patients. Check the sex recorded at registration.' });
    const lmp = toDate(input.lmp);
    const weeks = weeksSince(lmp, today());
    if (weeks < 0) throw new EmrError('VALIDATION_FAILED', { message: 'The last menstrual period cannot be in the future.' });
    if (weeks > MAX_WEEKS) throw new EmrError('VALIDATION_FAILED', { message: `That LMP is more than ${MAX_WEEKS} weeks ago. Check the date.` });
    let row;
    try {
      row = await tx.emrPregnancy.create({
        data: {
          organizationId: context.organizationId, patientId: patient.id, lmp, edd: new Date(lmp.getTime() + 280 * DAY),
          gravida: input.gravida, parity: input.parity, bloodGroup: input.bloodGroup ?? null, bookingHb: input.bookingHb ?? null, ttDoses: input.ttDoses,
          enrolledByUserId: context.userId,
        },
      });
    } catch (error) {
      throw uniqueViolation(error, { one_active: 'PREGNANCY_ALREADY_ACTIVE' }) ?? error;
    }
    return { statusCode: 201, body: await done(tx, context, row, 'enrolled') };
  }));
}

export async function recordVisit(context, pregnancyId, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'anc.visit', body: { pregnancyId, ...input } }, async () => {
    const pregnancy = await tx.emrPregnancy.findFirst({ where: { organizationId: context.organizationId, id: pregnancyId } });
    if (!pregnancy) throw new EmrError('PREGNANCY_NOT_FOUND');
    if (pregnancy.status !== 'ACTIVE') throw new EmrError('INVALID_STATE', { message: 'Visits can only be recorded on an ongoing pregnancy.' });
    const visitDate = toDate(input.visitDate);
    if (visitDate > today()) throw new EmrError('VALIDATION_FAILED', { message: 'The visit date cannot be in the future.' });
    if (visitDate < pregnancy.lmp) throw new EmrError('VALIDATION_FAILED', { message: 'The visit date is before the last menstrual period.' });
    const gestationalWeeks = weeksSince(pregnancy.lmp, visitDate);
    if (gestationalWeeks > MAX_WEEKS) throw new EmrError('VALIDATION_FAILED', { message: `That visit would be at ${gestationalWeeks} weeks. Check the date, or close this pregnancy.` });
    const visit = await tx.emrAncVisit.create({
      data: {
        organizationId: context.organizationId, pregnancyId: pregnancy.id, patientId: pregnancy.patientId, visitDate, gestationalWeeks,
        weightKg: input.weightKg ?? null, systolic: input.systolic ?? null, diastolic: input.diastolic ?? null, hb: input.hb ?? null,
        fetalHeartRate: input.fetalHeartRate ?? null, nextVisitDate: input.nextVisitDate ? toDate(input.nextVisitDate) : null, notes: input.notes ?? null,
        recordedByUserId: context.userId,
      },
    });
    return { statusCode: 201, body: await done(tx, context, pregnancy, 'visit_recorded', { visitId: visit.id }) };
  }));
}

export async function markVisitEnteredInError(context, pregnancyId, visitId, { reason }) {
  return withTenant(context, async (tx) => {
    const pregnancy = await tx.emrPregnancy.findFirst({ where: { organizationId: context.organizationId, id: pregnancyId } });
    if (!pregnancy) throw new EmrError('PREGNANCY_NOT_FOUND');
    await markEnteredInError(tx.emrAncVisit, {
      where: { organizationId: context.organizationId, id: visitId, pregnancyId }, userId: context.userId, reason, notFoundCode: 'ANC_VISIT_NOT_FOUND', label: 'visit',
    });
    return done(tx, context, pregnancy, 'visit_entered_in_error', { visitId });
  });
}

export async function closePregnancy(context, pregnancyId, expectedVersion, { status, note }) {
  return withTenant(context, async (tx) => {
    const pregnancy = await tx.emrPregnancy.findFirst({ where: { organizationId: context.organizationId, id: pregnancyId } });
    if (!pregnancy) throw new EmrError('PREGNANCY_NOT_FOUND');
    if (pregnancy.status !== 'ACTIVE') throw new EmrError('INVALID_STATE', { message: 'This pregnancy is already closed.' });
    await updateVersioned(tx.emrPregnancy, {
      organizationId: context.organizationId, id: pregnancy.id, expectedVersion, notFoundCode: 'PREGNANCY_NOT_FOUND',
      data: { status, closedAt: new Date(), closedByUserId: context.userId, closureNote: note ?? null },
    });
    return done(tx, context, pregnancy, 'closed', { status });
  });
}
