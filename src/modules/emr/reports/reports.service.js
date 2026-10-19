// Reporting, computed from the record. `source` gives the report builder the period's visits (with
// diagnoses and prescriptions) and lab orders, the people those records name (not the whole register),
// and register totals. `counts` gives NHMIS dataset sizes and the MSF figures the EMR can derive. The
// MSF itself is saved per month as a draft, then locked as COMPILED — nothing is sent to the LGA,
// DHIS2 or any other platform.
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { updateVersioned } from '../core/concurrency.js';
import { EmrError } from '../core/errors.js';
import { userNameMap } from '../core/people.js';
import { withStaffNamesForReports } from '../lab/lab.service.js';

const DAY = 86_400_000;
const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : null);
const range = ({ from, to }) => ({ gte: new Date(`${from}T00:00:00.000Z`), lt: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + DAY) });
const MAX = 5000;
const patientFields = { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true };

export async function reportSource(context, period) {
  const when = range(period);
  return withTenant(context, async (tx) => {
    const encounters = await tx.emrEncounter.findMany({
      where: { organizationId: context.organizationId, arrivedAt: when, status: { not: 'CANCELLED' } },
      select: { id: true, patientId: true, reason: true, status: true, arrivedAt: true, attendingUserId: true, visitType: true },
      orderBy: { arrivedAt: 'desc' }, take: MAX,
    });
    const ids = encounters.map((e) => e.id);
    const [diagnoses, prescriptions, labOrders, registry] = await Promise.all([
      ids.length ? tx.emrDiagnosis.findMany({ where: { organizationId: context.organizationId, encounterId: { in: ids }, status: 'ACTIVE' }, select: { encounterId: true, code: true, description: true } }) : [],
      ids.length ? tx.emrPrescription.findMany({ where: { organizationId: context.organizationId, encounterId: { in: ids } }, select: { encounterId: true, items: { select: { drugName: true } } } }) : [],
      withStaffNamesForReports(tx, context, when, MAX),
      tx.emrPatient.groupBy({ by: ['consentToContact'], where: { organizationId: context.organizationId, status: 'ACTIVE' }, _count: { _all: true } }),
    ]);
    const patientIds = [...new Set([...encounters.map((e) => e.patientId), ...labOrders.map((o) => o.patientId)])];
    const patients = patientIds.length ? await tx.emrPatient.findMany({ where: { organizationId: context.organizationId, id: { in: patientIds } }, select: patientFields }) : [];
    const names = await userNameMap(tx, encounters.map((e) => e.attendingUserId));
    const count = (value) => registry.filter((g) => g.consentToContact === value).reduce((n, g) => n + g._count._all, 0);
    await recordAudit(tx, context, { action: 'report.source_viewed', resourceType: 'report' });
    return {
      from: period.from, to: period.to, truncated: encounters.length === MAX || labOrders.length === MAX,
      encounters: encounters.map((e) => ({
        id: e.id, patientId: e.patientId, date: e.arrivedAt, complaint: e.reason ?? '', status: e.status, visitType: e.visitType,
        provider: e.attendingUserId ? names.get(e.attendingUserId) ?? null : null,
        diagnoses: diagnoses.filter((d) => d.encounterId === e.id).map((d) => ({ code: d.code, name: d.description })),
        prescriptions: prescriptions.filter((p) => p.encounterId === e.id).flatMap((p) => p.items.map((i) => ({ drug: i.drugName }))),
      })),
      labOrders,
      patients: patients.map((p) => ({ ...p, dateOfBirth: isoDay(p.dateOfBirth) })),
      registry: { total: registry.reduce((n, g) => n + g._count._all, 0), consentYes: count(true), consentNo: count(false), consentUnknown: count(null) },
    };
  });
}

export async function periodCounts(context, period) {
  const when = range(period);
  const day = { gte: when.gte, lt: when.lt };
  const org = { organizationId: context.organizationId };
  return withTenant(context, async (tx) => {
    const [encounters, immunizations, pregnancies, ancVisits, deliveries, pncVisits, pnc48h, births, surveillance, fpNew, fpRevisits, fpClients, referrals, referralsOut, transfers, doses] = await Promise.all([
      tx.emrEncounter.findMany({ where: { ...org, arrivedAt: when, status: { not: 'CANCELLED' } }, select: { id: true, patientId: true }, take: 50000 }),
      tx.emrImmunization.count({ where: { ...org, givenAt: when, status: 'ACTIVE' } }),
      tx.emrPregnancy.count({ where: { ...org, createdAt: when } }),
      tx.emrAncVisit.count({ where: { ...org, visitDate: day, status: 'ACTIVE' } }),
      tx.emrDelivery.count({ where: { ...org, deliveredAt: when, status: 'ACTIVE' } }),
      tx.emrPncVisit.count({ where: { ...org, visitDate: day, status: 'ACTIVE' } }),
      tx.emrPncVisit.count({ where: { ...org, visitDate: day, status: 'ACTIVE', daysPostpartum: { lte: 2 } } }),
      tx.emrBirthRegistration.count({ where: { ...org, notifiedAt: when } }),
      tx.emrSurveillanceCase.count({ where: { ...org, reportedAt: when } }),
      tx.emrFpClient.count({ where: { ...org, startDate: day, firstTime: true } }),
      tx.emrFpVisit.count({ where: { ...org, visitDate: day, visitType: { not: 'NEW_VISIT' } } }),
      tx.emrFpClient.count({ where: { ...org, createdAt: when } }),
      tx.emrReferral.count({ where: { ...org, createdAt: when } }),
      tx.emrReferral.count({ where: { ...org, createdAt: when, direction: 'OUT' } }),
      tx.emrPatientTransfer.count({ where: { ...org, createdAt: when, status: { not: 'CANCELLED' } } }),
      tx.emrImmunization.groupBy({ by: ['vaccineCode'], where: { ...org, givenAt: when, status: 'ACTIVE' }, _count: { _all: true } }),
    ]);
    const ids = encounters.map((e) => e.id);
    const patientIds = [...new Set(encounters.map((e) => e.patientId))];
    const [malaria, seenBefore] = await Promise.all([
      ids.length ? tx.emrDiagnosis.findMany({ where: { ...org, encounterId: { in: ids }, status: 'ACTIVE', description: { contains: 'malaria', mode: 'insensitive' } }, select: { encounterId: true }, distinct: ['encounterId'] }) : [],
      patientIds.length ? tx.emrEncounter.findMany({ where: { ...org, patientId: { in: patientIds }, arrivedAt: { lt: when.gte }, status: { not: 'CANCELLED' } }, select: { patientId: true }, distinct: ['patientId'] }) : [],
    ]);
    // A person's first visit in the period is new if they had no visit before it; every other visit is a re-attendance.
    const returning = new Set(seenBefore.map((e) => e.patientId));
    const newAttendances = patientIds.filter((id) => !returning.has(id)).length;
    const dose = (match) => doses.filter((d) => match(d.vaccineCode)).reduce((n, d) => n + d._count._all, 0);
    await recordAudit(tx, context, { action: 'report.counts_viewed', resourceType: 'report' });
    return {
      from: period.from, to: period.to,
      datasets: {
        opd: encounters.length, immunization: immunizations, maternal: pregnancies + ancVisits + deliveries + pncVisits, births, surveillance,
        familyPlanning: fpClients, referrals, transfers,
      },
      msf: {
        'New attendances': newAttendances, 'Re-attendances': encounters.length - newAttendances, 'Referrals out': referralsOut, 'Total visits': encounters.length,
        'ANC 1st visits': pregnancies, 'Deliveries by SBA': deliveries, 'PNC within 48h': pnc48h,
        BCG: dose((c) => c === 'BCG'), 'Penta 3': dose((c) => c === 'PENTA3'), 'Measles 1': dose((c) => c === 'MV1'), 'Vitamin A': dose((c) => c.startsWith('VITA')),
        'New acceptors': fpNew, Revisits: fpRevisits, 'Confirmed malaria': malaria.length,
      },
    };
  });
}

// ---- Monthly Summary Form ----------------------------------------------------------------------
const monthRange = (period) => {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
};

async function presentMsf(tx, row) {
  if (!row) return null;
  const names = await userNameMap(tx, [row.updatedByUserId, row.compiledByUserId]);
  return {
    id: row.id, period: row.period, values: row.values, status: row.status, version: row.version, updatedAt: row.updatedAt,
    updatedByName: names.get(row.updatedByUserId) ?? null, compiledByName: row.compiledByUserId ? names.get(row.compiledByUserId) ?? null : null, compiledAt: row.compiledAt,
  };
}

export async function getMsf(context, period) {
  const counts = await periodCounts(context, monthRange(period));
  return withTenant(context, async (tx) => {
    const row = await tx.emrMsfReturn.findFirst({ where: { organizationId: context.organizationId, period } });
    await recordAudit(tx, context, { action: 'msf.viewed', resourceType: 'msf_return', resourceId: row?.id });
    return { period, derived: counts.msf, saved: await presentMsf(tx, row) };
  });
}

export async function saveMsf(context, period, expectedVersion, { values }) {
  return withTenant(context, async (tx) => {
    const row = await tx.emrMsfReturn.findFirst({ where: { organizationId: context.organizationId, period } });
    let saved;
    if (!row) {
      if (expectedVersion !== undefined && expectedVersion !== 0) throw new EmrError('VERSION_CONFLICT', { details: { currentVersion: 0 } });
      saved = await tx.emrMsfReturn.create({ data: { organizationId: context.organizationId, period, values, updatedByUserId: context.userId } });
    } else {
      if (row.status === 'COMPILED') throw new EmrError('INVALID_STATE', { message: 'This return is compiled and locked.' });
      if (expectedVersion === undefined) throw new EmrError('PRECONDITION_REQUIRED');
      saved = await updateVersioned(tx.emrMsfReturn, { organizationId: context.organizationId, id: row.id, expectedVersion, notFoundCode: 'NOT_FOUND', data: { values, updatedByUserId: context.userId, updatedAt: new Date() } });
    }
    await recordAudit(tx, context, { action: 'msf.saved', resourceType: 'msf_return', resourceId: saved.id });
    return presentMsf(tx, saved);
  });
}

export async function compileMsf(context, period, expectedVersion) {
  return withTenant(context, async (tx) => {
    const row = await tx.emrMsfReturn.findFirst({ where: { organizationId: context.organizationId, period } });
    if (!row) throw new EmrError('INVALID_STATE', { message: 'Save the return before compiling it.' });
    if (row.status === 'COMPILED') throw new EmrError('INVALID_STATE', { message: 'This return is already compiled.' });
    const now = new Date();
    const saved = await updateVersioned(tx.emrMsfReturn, { organizationId: context.organizationId, id: row.id, expectedVersion, notFoundCode: 'NOT_FOUND', data: { status: 'COMPILED', compiledByUserId: context.userId, compiledAt: now, updatedByUserId: context.userId, updatedAt: now } });
    await recordAudit(tx, context, { action: 'msf.compiled', resourceType: 'msf_return', resourceId: saved.id });
    return presentMsf(tx, saved);
  });
}
