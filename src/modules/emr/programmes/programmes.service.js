// Public-health programmes. NCD: a register of chronic-care clients (one active enrolment per person
// and condition). Malaria: NHMIS-style indicators worked out from what is already recorded — suspected
// (visits whose reason mentions fever, or with a malaria diagnosis), tested (malaria lab tests), positive
// (a current result reading positive/present), confirmed (active malaria diagnoses) and treated with ACT
// (an artemisinin-based prescription in the same visit) — plus a weekly testing trend.
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { userNameMap } from '../core/people.js';
import { findPatient } from '../patients/patients.repository.js';

export const NCD_CONDITIONS = ['Essential hypertension', 'Type 2 Diabetes Mellitus', 'Hypertension + Diabetes', 'Asthma', 'Sickle Cell Disease'];
const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : null);
const patientSummary = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true } };
const withPatient = (p) => (p ? { ...p, dateOfBirth: isoDay(p.dateOfBirth) } : undefined);
const DAY = 86_400_000;

// ---- NCD ---------------------------------------------------------------------------------------
export async function listNcd(context, { dueWithinDays, limit }) {
  return withTenant(context, async (tx) => {
    const rows = await tx.emrNcdClient.findMany({
      where: { organizationId: context.organizationId, ...(dueWithinDays !== undefined ? { nextVisitDate: { lt: new Date(Date.now() + dueWithinDays * DAY) } } : {}) },
      include: { patient: patientSummary }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit,
    });
    await recordAudit(tx, context, { action: 'ncd.listed', resourceType: 'ncd_client' });
    const names = await userNameMap(tx, rows.map((r) => r.enrolledByUserId));
    return {
      items: rows.map((r) => ({
        id: r.id, patientId: r.patientId, patient: withPatient(r.patient), condition: r.condition, systolic: r.systolic, diastolic: r.diastolic,
        fastingGlucoseMmol: r.fastingGlucoseMmol === null ? null : Number(r.fastingGlucoseMmol), control: r.control, nextVisitDate: isoDay(r.nextVisitDate),
        enrolledAt: r.createdAt, enrolledByName: names.get(r.enrolledByUserId) ?? null,
      })),
    };
  });
}

export async function enrolNcd(context, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'ncd.enrol', body: input }, async () => {
    const patient = await findPatient(tx, context.organizationId, input.patientId, { id: true, status: true });
    if (!patient) throw new EmrError('PATIENT_NOT_FOUND');
    if (patient.status !== 'ACTIVE') throw new EmrError('PATIENT_INACTIVE');
    if (new Date(`${input.nextVisitDate}T00:00:00.000Z`).getTime() < Date.now() - DAY) throw new EmrError('VALIDATION_FAILED', { message: 'The next visit must be today or later.' });
    let row;
    try {
      row = await tx.emrNcdClient.create({
        data: {
          organizationId: context.organizationId, patientId: patient.id, condition: input.condition, systolic: input.systolic ?? null, diastolic: input.diastolic ?? null,
          fastingGlucoseMmol: input.fastingGlucoseMmol ?? null, control: input.control, nextVisitDate: new Date(`${input.nextVisitDate}T00:00:00.000Z`), enrolledByUserId: context.userId,
        },
      });
    } catch (error) {
      throw uniqueViolation(error, { one_active: 'NCD_ALREADY_ENROLLED' }) ?? error;
    }
    await recordAudit(tx, context, { action: 'ncd.enrolled', resourceType: 'ncd_client', resourceId: row.id });
    await enqueueEvent(tx, context, { type: 'ncd.enrolled', aggregateType: 'patient', aggregateId: patient.id, data: { ncdClientId: row.id, condition: row.condition } });
    return { statusCode: 201, body: (await listNcdOne(tx, context, row.id)) };
  }));
}
async function listNcdOne(tx, context, id) {
  const r = await tx.emrNcdClient.findFirst({ where: { organizationId: context.organizationId, id }, include: { patient: patientSummary } });
  const names = await userNameMap(tx, [r.enrolledByUserId]);
  return {
    id: r.id, patientId: r.patientId, patient: withPatient(r.patient), condition: r.condition, systolic: r.systolic, diastolic: r.diastolic,
    fastingGlucoseMmol: r.fastingGlucoseMmol === null ? null : Number(r.fastingGlucoseMmol), control: r.control, nextVisitDate: isoDay(r.nextVisitDate),
    enrolledAt: r.createdAt, enrolledByName: names.get(r.enrolledByUserId) ?? null,
  };
}

// ---- Malaria -----------------------------------------------------------------------------------
const MALARIA = { contains: 'malaria', mode: 'insensitive' };
const ACT = ['artemether', 'lumefantrine', 'artesunate', 'amodiaquine', 'dihydroartemisinin', 'piperaquine'];
const isAct = (drugName) => ACT.some((name) => drugName.toLowerCase().includes(name));
const weekStart = (date) => {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // ISO weeks start on Monday
  return d.toISOString().slice(0, 10);
};

export async function malariaIndicators(context, { since }) {
  const from = since ? new Date(`${since}T00:00:00.000Z`) : new Date(Date.now() - 365 * DAY);
  return withTenant(context, async (tx) => {
    const [diagnoses, feverVisits, tests] = await Promise.all([
      tx.emrDiagnosis.findMany({
        where: { organizationId: context.organizationId, status: 'ACTIVE', description: MALARIA, createdAt: { gte: from } },
        select: { encounterId: true, patientId: true, description: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 2000,
      }),
      tx.emrEncounter.findMany({ where: { organizationId: context.organizationId, reason: { contains: 'fever', mode: 'insensitive' }, createdAt: { gte: from }, status: { not: 'CANCELLED' } }, select: { id: true }, take: 5000 }),
      tx.emrLabOrderItem.findMany({
        where: { organizationId: context.organizationId, OR: [{ testName: MALARIA }, { testCode: { in: ['MP_RDT', 'MP_MICRO', 'MPS', 'MALARIA_RDT'] } }], createdAt: { gte: from } },
        select: { id: true, createdAt: true, results: { where: { status: { not: 'SUPERSEDED' } }, select: { valueText: true } } }, take: 5000,
      }),
    ]);
    const confirmedVisits = [...new Map(diagnoses.map((d) => [d.encounterId, d])).values()];
    const prescriptions = confirmedVisits.length ? await tx.emrPrescription.findMany({
      where: { organizationId: context.organizationId, encounterId: { in: confirmedVisits.map((d) => d.encounterId) } },
      select: { encounterId: true, items: { select: { drugName: true } } },
    }) : [];
    const treatmentFor = (encounterId) => prescriptions.filter((p) => p.encounterId === encounterId).flatMap((p) => p.items.map((i) => i.drugName));
    const patients = confirmedVisits.length ? await tx.emrPatient.findMany({ where: { organizationId: context.organizationId, id: { in: [...new Set(confirmedVisits.map((d) => d.patientId))] } }, ...patientSummary }) : [];
    const positive = (item) => item.results.some((r) => /positive|present|seen/i.test(r.valueText ?? '') && !/not seen|negative/i.test(r.valueText ?? ''));

    const trend = new Map();
    for (const item of tests) {
      const key = weekStart(item.createdAt);
      const entry = trend.get(key) ?? { weekStart: key, tested: 0, positive: 0 };
      entry.tested += 1;
      if (positive(item)) entry.positive += 1;
      trend.set(key, entry);
    }
    await recordAudit(tx, context, { action: 'malaria.indicators_viewed', resourceType: 'programme' });
    const suspected = new Set([...feverVisits.map((v) => v.id), ...confirmedVisits.map((d) => d.encounterId)]);
    return {
      since: isoDay(from),
      suspected: suspected.size,
      tested: tests.length,
      positive: tests.filter(positive).length,
      confirmed: confirmedVisits.length,
      treatedWithAct: confirmedVisits.filter((d) => treatmentFor(d.encounterId).some(isAct)).length,
      cases: confirmedVisits.map((d) => ({
        encounterId: d.encounterId, patientId: d.patientId, patient: withPatient(patients.find((p) => p.id === d.patientId)), diagnosedAt: d.createdAt,
        diagnoses: diagnoses.filter((x) => x.encounterId === d.encounterId).map((x) => x.description), treatment: treatmentFor(d.encounterId),
      })),
      weeklyTrend: [...trend.values()].sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1)),
    };
  });
}
