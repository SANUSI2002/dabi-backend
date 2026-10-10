// The workspace dashboard: today's clinic figures, the signed-in person's own work queue, stock
// alerts, this month's activity and recent changes — one read, each part only for a role that may
// see it (null otherwise, so the screen can say so rather than show zero).
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { userNameMap } from '../core/people.js';
import { money } from '../billing/billing.policy.js';

const LIST = 50;
const CRITICAL = ['CRITICAL_LOW', 'CRITICAL_HIGH'];
const todayUtc = () => new Date().toISOString().slice(0, 10);
const named = { select: { id: true, givenName: true, familyName: true, medicalRecordNumber: true } };
const patientOf = (p) => (p ? { id: p.id, name: `${p.givenName} ${p.familyName}`, medicalRecordNumber: p.medicalRecordNumber } : null);
const resultText = (r) => `${r.analyteName}: ${r.valueNumeric !== null && r.valueNumeric !== undefined ? `${Number(r.valueNumeric)}${r.unit ? ` ${r.unit}` : ''}` : r.valueText ?? '—'}`;

/**
 * `since` is the start of the caller's day and `monthStart` the start of their month (the screen
 * sends its own local times, so "today" matches the clock on the ward wall).
 */
export async function dashboard(context, { since, monthStart }) {
  const org = context.organizationId;
  const me = context.userId;
  const may = (...codes) => codes.some((code) => context.permissions.includes(code));
  const today = new Date(since);
  const month = new Date(monthStart);

  return withTenant(context, async (tx) => {
    const out = { queue: null, patients: null, labPending: null, prescriptionsPending: null, beds: null, lowStock: null, work: {}, month: {}, revenue: null, activity: null };

    if (may('queue.read')) {
      const counts = await tx.emrQueueEntry.groupBy({ by: ['status'], where: { organizationId: org, queuedAt: { gte: today } }, _count: { _all: true } });
      const count = (status) => counts.find((c) => c.status === status)?._count._all ?? 0;
      out.queue = { waiting: count('WAITING'), inProgress: count('IN_PROGRESS'), completed: count('COMPLETED'), referred: count('REFERRED') };
    }
    if (may('patient.read')) out.patients = await tx.emrPatient.count({ where: { organizationId: org, status: 'ACTIVE' } });
    if (may('prescription.read', 'prescription.review', 'prescription.dispense')) {
      out.prescriptionsPending = await tx.emrPrescription.count({ where: { organizationId: org, status: { in: ['PENDING_REVIEW', 'APPROVED', 'PARTIALLY_DISPENSED'] } } });
      out.month.prescriptionsDispensed = await tx.emrDispense.count({ where: { organizationId: org, dispensedAt: { gte: month } } });
    }
    if (may('admission.read', 'bed.manage')) {
      const [beds, admitted, admittedThisMonth] = await Promise.all([
        tx.emrBed.groupBy({ by: ['status'], where: { organizationId: org, ward: { active: true } }, _count: { _all: true } }),
        tx.emrAdmission.count({ where: { organizationId: org, status: 'ADMITTED' } }),
        tx.emrAdmission.count({ where: { organizationId: org, admittedAt: { gte: month }, status: { not: 'CANCELLED' } } }),
      ]);
      const count = (status) => beds.find((b) => b.status === status)?._count._all ?? 0;
      out.beds = { available: count('AVAILABLE'), occupied: count('OCCUPIED'), total: beds.reduce((sum, b) => sum + b._count._all, 0), admitted };
      out.month.admissions = admittedThisMonth;
    }
    if (may('encounter.read')) {
      out.month.outpatientVisits = await tx.emrEncounter.count({ where: { organizationId: org, class: 'OUTPATIENT', arrivedAt: { gte: month }, status: { not: 'CANCELLED' } } });
    }

    if (may('emr.stock.view')) {
      const drugs = await tx.emrFormularyItem.findMany({
        where: { organizationId: org, active: true },
        include: { batches: { where: { quantityOnHand: { gt: 0 }, expiryDate: { gt: new Date(`${todayUtc()}T00:00:00.000Z`) } }, select: { quantityOnHand: true } } },
        orderBy: { genericName: 'asc' },
      });
      out.lowStock = drugs
        .map((d) => ({ code: d.code, name: `${d.genericName} ${d.strength}`, form: d.form, onHand: d.batches.reduce((sum, b) => sum + b.quantityOnHand, 0), reorderLevel: d.reorderLevel }))
        .filter((d) => d.onHand <= d.reorderLevel);
    }

    if (may('lab.order.read')) {
      const open = { organizationId: org, order: { status: { not: 'CANCELLED' } } };
      const [pending, critical, unacknowledged, resultedThisMonth] = await Promise.all([
        tx.emrLabOrderItem.findMany({
          where: { ...open, status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 200,
          select: { id: true, testName: true, createdAt: true, order: { select: { patient: named, status: true, collectedAt: true } } },
        }),
        // Critical values the lab has not yet told a clinician about.
        tx.emrLabOrderItem.findMany({
          where: { ...open, status: { in: ['RESULTED', 'VERIFIED'] }, criticalCommunicatedAt: null, results: { some: { status: { not: 'SUPERSEDED' }, flag: { in: CRITICAL } } } },
          orderBy: { resultedAt: 'asc' }, take: LIST,
          select: { id: true, testName: true, resultedAt: true, order: { select: { patient: named } }, results: { where: { status: { not: 'SUPERSEDED' }, flag: { in: CRITICAL } } } },
        }),
        // Released results on tests the caller ordered that they have not acknowledged yet.
        tx.emrLabOrderItem.findMany({
          where: { ...open, status: 'VERIFIED', acknowledgedAt: null, order: { status: { not: 'CANCELLED' }, orderedByUserId: me } },
          orderBy: { verifiedAt: 'asc' }, take: LIST,
          select: { id: true, testName: true, verifiedAt: true, order: { select: { patient: named } }, results: { where: { status: { not: 'SUPERSEDED' } }, orderBy: { analyteCode: 'asc' } } },
        }),
        tx.emrLabOrderItem.count({ where: { organizationId: org, verifiedAt: { gte: month } } }),
      ]);
      out.labPending = pending.length;
      out.work.pendingLabTests = pending.map((i) => ({ id: i.id, testName: i.testName, orderedAt: i.createdAt, collectedAt: i.order.collectedAt, patient: patientOf(i.order.patient) }));
      out.work.criticalResults = critical.map((i) => ({ id: i.id, testName: i.testName, resultedAt: i.resultedAt, result: i.results.map(resultText).join('; '), patient: patientOf(i.order.patient) }));
      out.work.resultsToAcknowledge = unacknowledged.map((i) => {
        const flagged = i.results.filter((r) => r.flag && r.flag !== 'NORMAL');
        return {
          id: i.id, testName: i.testName, verifiedAt: i.verifiedAt, patient: patientOf(i.order.patient),
          result: (flagged.length ? flagged : i.results).slice(0, 3).map(resultText).join('; '), abnormal: flagged.length > 0,
        };
      });
      out.month.labTestsResulted = resultedThisMonth;
    }

    if (may('clinical.note.write')) {
      const drafts = await tx.emrClinicalNote.findMany({
        where: { organizationId: org, authorUserId: me, status: 'DRAFT' }, orderBy: { createdAt: 'asc' }, take: LIST,
        select: { id: true, encounterId: true, patientId: true, kind: true, subjective: true, createdAt: true },
      });
      const [patients, visits] = drafts.length ? await Promise.all([
        tx.emrPatient.findMany({ where: { organizationId: org, id: { in: [...new Set(drafts.map((d) => d.patientId))] } }, ...named }),
        tx.emrEncounter.findMany({ where: { organizationId: org, id: { in: [...new Set(drafts.map((d) => d.encounterId))] } }, select: { id: true, reason: true } }),
      ]) : [[], []];
      out.work.unsignedNotes = drafts.map((d) => ({
        id: d.id, encounterId: d.encounterId, kind: d.kind, createdAt: d.createdAt,
        reason: visits.find((v) => v.id === d.encounterId)?.reason ?? d.subjective ?? null,
        patient: patientOf(patients.find((p) => p.id === d.patientId)),
      }));
    }

    if (may('billing.read')) {
      const [collected, unpaid] = await Promise.all([
        tx.emrPayment.aggregate({ where: { organizationId: org, status: 'POSTED', receivedAt: { gte: month } }, _sum: { amountMinor: true } }),
        tx.emrInvoice.count({ where: { organizationId: org, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } } }),
      ]);
      out.revenue = { collectedThisMonthMinor: money(collected._sum.amountMinor ?? 0n), unpaidInvoices: unpaid };
    }

    if (may('audit.view')) {
      // Changes only: reads (viewed/listed) would drown out what people actually did.
      const events = await tx.emrAuditEvent.findMany({
        where: { organizationId: org, NOT: [{ action: { endsWith: '.viewed' } }, { action: { endsWith: '.listed' } }] },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 8,
        select: { id: true, action: true, resourceType: true, actorUserId: true, createdAt: true },
      });
      const names = await userNameMap(tx, events.map((e) => e.actorUserId));
      out.activity = events.map(({ actorUserId, ...e }) => ({ ...e, actorName: actorUserId ? names.get(actorUserId) ?? null : null }));
    }

    await recordAudit(tx, context, { action: 'dashboard.viewed', resourceType: 'organization' });
    return out;
  });
}
