// /api/v1/command-centre — the rest of Sabi Health's live products, for platform staff:
//   /prescriptions        Sabi prescriptions (metadata; medicine names only with clinical permission + reason)
//   /marketplace          prescription quote requests and stock holds
//   /wellness             wellness providers, offerings and bookings
//   /hospitals            hospital member plans, enrolments and appointment requests
//   /laboratories         laboratory and diagnostic organisations
//   /verification         everything waiting for a verification decision, oldest first
//   /waitlist             product waitlist sign-ups (masked)
//   /emr/tenants          hospitals using the EMR: members, package, activity counts (never clinical content)
import express from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { withTenant, withWorker } from '../emr/core/db.js';
import { metricsSnapshot } from '../emr/core/logging.js';
import { adminAudit, allow, ccError, handle, maskEmail, pageQuery, paged, rangeQuery, rangeWhere, reason } from './cc.common.js';

export const productRoutes = express.Router();

const none = z.object({}).strict();
const uuid = z.string().uuid();
const DAY = 86_400_000;
const READ = allow('platform.ops.read');
const listQuery = (extra) => validate(z.object({ query: z.object({ ...extra, ...pageQuery }).strict(), params: none }).passthrough());
const person = (u) => (u ? { id: u.id, patientId: u.patientId, name: u.full_name } : null);

// ------------------------------------------------------------------------------------------------
// Prescriptions
// ------------------------------------------------------------------------------------------------
productRoutes.get('/prescriptions', READ,
  listQuery({ status: z.enum(['DRAFT', 'ISSUED', 'CANCELLED']).optional(), q: z.string().trim().max(60).optional(), doctorProfileId: uuid.optional(), patientId: uuid.optional(), ...rangeQuery }),
  handle(async (req) => {
    const { status, q, doctorProfileId, patientId, page, limit } = req.query;
    const where = {
      status: status ?? { not: 'DRAFT' }, ...rangeWhere(req.query), ...(doctorProfileId ? { doctorProfileId } : {}), ...(patientId ? { patientId } : {}),
      ...(q ? { OR: [{ reference: { contains: q, mode: 'insensitive' } }, { patient: { patientId: { contains: q, mode: 'insensitive' } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.prescription.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit,
        include: { patient: { select: { id: true, patientId: true, full_name: true } }, doctorProfile: { select: { id: true, specialty: true, user: { select: { full_name: true } } } },
          _count: { select: { items: true, pharmacyRequests: true } }, reservations: { select: { status: true, order: { select: { id: true, reference: true, status: true } } } } } }),
      prisma.prescription.count({ where }),
    ]);
    return paged(rows.map((p) => ({
      id: p.id, reference: p.reference, status: p.status, createdAt: p.createdAt, issuedAt: p.issuedAt, cancelledAt: p.cancelledAt,
      patient: person(p.patient), doctor: { profileId: p.doctorProfile.id, name: p.doctorProfile.user.full_name, specialty: p.doctorProfile.specialty },
      items: p._count.items, pharmacyRequests: p._count.pharmacyRequests,
      orders: p.reservations.filter((r) => r.order).map((r) => r.order),
      stage: p.status !== 'ISSUED' ? p.status : p.reservations.some((r) => r.order?.status === 'PAID') ? 'PURCHASED' : p._count.pharmacyRequests ? 'QUOTES_REQUESTED' : 'NOT_YET_SHOPPED',
    })), total, { page, limit });
  }));

productRoutes.get('/prescriptions/:id', READ,
  validate(z.object({ query: none, params: z.object({ id: uuid }).strict() }).passthrough()),
  handle(async (req) => {
    const p = await prisma.prescription.findUnique({
      where: { id: req.params.id },
      include: {
        patient: { select: { id: true, patientId: true, full_name: true } }, doctorProfile: { select: { id: true, specialty: true, user: { select: { full_name: true } } } },
        _count: { select: { items: true } },
        pharmacyRequests: { orderBy: { createdAt: 'asc' }, include: { pharmacy: { select: { id: true, name: true } }, quotes: { orderBy: { revision: 'asc' }, select: { id: true, revision: true, status: true, quoteExpiresAt: true, createdAt: true, items: { select: { lineTotalMinor: true, availabilityStatus: true } } } } } },
        reservations: { orderBy: { createdAt: 'asc' }, select: { id: true, status: true, expiresAt: true, createdAt: true, releasedAt: true, order: { select: { id: true, reference: true, status: true, totalPayableMinor: true } } } },
      },
    });
    if (!p) throw ccError('NOT_FOUND', 404, 'Prescription not found.');
    const timeline = [
      { at: p.createdAt, kind: 'NOTE', text: 'Prescription drafted' },
      p.issuedAt && { at: p.issuedAt, kind: 'NOTE', text: `Issued by ${p.doctorProfile.user.full_name ?? 'the doctor'}` },
      ...p.pharmacyRequests.flatMap((r) => [
        { at: r.createdAt, kind: 'PHARMACY', text: `Quote requested from ${r.pharmacy.name}` },
        ...r.quotes.map((q) => ({ at: q.createdAt, kind: 'PHARMACY', text: `${r.pharmacy.name} quoted (revision ${q.revision}, ${q.status.toLowerCase()})` })),
      ]),
      ...p.reservations.flatMap((r) => [{ at: r.createdAt, kind: 'ORDER', text: `Stock held until ${r.expiresAt.toISOString()}` }, r.order && { at: r.createdAt, kind: 'ORDER', text: `Order ${r.order.reference} (${r.order.status.toLowerCase().replace('_', ' ')})` }]),
      p.cancelledAt && { at: p.cancelledAt, kind: 'NOTE', text: 'Prescription cancelled' },
    ].filter(Boolean).sort((a, b) => a.at - b.at);
    return {
      id: p.id, reference: p.reference, status: p.status, createdAt: p.createdAt, issuedAt: p.issuedAt, cancelledAt: p.cancelledAt,
      patient: person(p.patient), doctor: { profileId: p.doctorProfile.id, name: p.doctorProfile.user.full_name, specialty: p.doctorProfile.specialty }, itemCount: p._count.items,
      requests: p.pharmacyRequests.map((r) => ({ id: r.id, pharmacy: r.pharmacy, status: r.status, requestedAt: r.createdAt,
        quotes: r.quotes.map((q) => ({ id: q.id, revision: q.revision, status: q.status, expiresAt: q.quoteExpiresAt, createdAt: q.createdAt, totalMinor: q.items.reduce((n, i) => n + i.lineTotalMinor, 0), unavailableLines: q.items.filter((i) => i.availabilityStatus !== 'AVAILABLE').length })) })),
      reservations: p.reservations,
      timeline,
      contentNote: 'Medicine names and doses are clinical information: open them with a stated reason (clinical permission required).',
    };
  }));

/** Medicines on a prescription: clinical information, so clinical permission + a reason, audited. */
productRoutes.post('/prescriptions/:id/items', allow('platform.clinical.read'),
  validate(z.object({ body: z.object({ reason }).strict(), query: none, params: z.object({ id: uuid }).strict() })),
  handle(async (req) => {
    const p = await prisma.prescription.findUnique({ where: { id: req.params.id }, select: { id: true, reference: true, patientId: true, items: { select: { id: true, medicationName: true, dosage: true, frequency: true, route: true, duration: true, quantity: true } } } });
    if (!p) throw ccError('NOT_FOUND', 404, 'Prescription not found.');
    await adminAudit(prisma, req, { action: 'ADMIN_CLINICAL_VIEWED', summary: `Opened the medicines on prescription ${p.reference}`, subjectUserId: p.patientId, resourceType: 'prescription', resourceId: p.id, reason: req.body.reason });
    return { items: p.items };
  }));

// ------------------------------------------------------------------------------------------------
// Prescription marketplace: quote requests and stock holds
// ------------------------------------------------------------------------------------------------
productRoutes.get('/marketplace/requests', READ,
  listQuery({ status: z.enum(['REQUESTED', 'QUOTED', 'CANCELLED']).optional(), unanswered: z.enum(['true', 'false']).optional() }),
  handle(async (req) => {
    const { status, unanswered, page, limit } = req.query;
    const where = { ...(status ? { status } : {}), ...(unanswered === 'true' ? { status: 'REQUESTED', createdAt: { lt: new Date(Date.now() - 2 * 3_600_000) } } : {}) };
    const [rows, total] = await Promise.all([
      prisma.prescriptionRequest.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit,
        include: { pharmacy: { select: { id: true, name: true } }, patient: { select: { id: true, patientId: true, full_name: true } }, prescription: { select: { id: true, reference: true } },
          quotes: { orderBy: { createdAt: 'asc' }, select: { revision: true, status: true, createdAt: true, quoteExpiresAt: true } } } }),
      prisma.prescriptionRequest.count({ where }),
    ]);
    return paged(rows.map((r) => {
      const first = r.quotes[0]; const latest = r.quotes.at(-1);
      return { id: r.id, status: r.status, requestedAt: r.createdAt, pharmacy: r.pharmacy, patient: person(r.patient), prescription: r.prescription,
        quotes: r.quotes.length, firstQuoteMinutes: first ? Math.round((first.createdAt - r.createdAt) / 60_000) : null, latestQuote: latest ? { status: latest.status, expiresAt: latest.quoteExpiresAt } : null };
    }), total, { page, limit });
  }));

productRoutes.get('/marketplace/holds', READ,
  listQuery({ status: z.enum(['ACTIVE', 'RELEASED', 'EXPIRED', 'CONVERTED']).optional() }),
  handle(async (req) => {
    const { status, page, limit } = req.query;
    const where = status ? { status } : {};
    const [rows, total, counts] = await Promise.all([
      prisma.reservation.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit,
        include: { patient: { select: { id: true, patientId: true, full_name: true } }, order: { select: { id: true, reference: true, status: true } }, allocations: { select: { lineTotalMinor: true, selectedQuantity: true, pharmacy: { select: { name: true } } } } } }),
      prisma.reservation.count({ where }),
      prisma.reservation.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    return {
      ...paged(rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, createdAt: r.createdAt, expiresAt: r.expiresAt, releasedAt: r.releasedAt, patient: person(r.patient), order: r.order,
        units: r.allocations.reduce((n, a) => n + a.selectedQuantity, 0), valueMinor: r.allocations.reduce((n, a) => n + a.lineTotalMinor, 0), pharmacies: [...new Set(r.allocations.map((a) => a.pharmacy.name))] })), total, { page, limit }),
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    };
  }));

// ------------------------------------------------------------------------------------------------
// Wellness
// ------------------------------------------------------------------------------------------------
productRoutes.get('/wellness', READ,
  listQuery({ view: z.enum(['bookings', 'offerings', 'providers']).default('bookings'), status: z.string().regex(/^[A-Z_]{3,20}$/).optional() }),
  handle(async (req) => {
    const { view, status, page, limit } = req.query;
    const skip = (page - 1) * limit;
    const providerName = (p) => p.organisation?.name ?? p.professional?.user?.full_name ?? 'Unnamed provider';
    const providerSelect = { select: { id: true, organisation: { select: { name: true } }, professional: { select: { professionType: true, user: { select: { full_name: true } } } } } };
    const [summary] = await Promise.all([prisma.wellnessBooking.groupBy({ by: ['status'], _count: { _all: true } })]);
    const counts = Object.fromEntries(summary.map((s) => [s.status, s._count._all]));
    if (view === 'providers') {
      const [rows, total] = await Promise.all([
        prisma.wellnessProvider.findMany({ orderBy: { createdAt: 'desc' }, skip, take: limit, include: { ...{ organisation: { select: { name: true, type: true, status: true } }, professional: { select: { professionType: true, verificationStatus: true, user: { select: { full_name: true } } } } }, offerings: { select: { status: true, _count: { select: { bookings: true } } } } } }),
        prisma.wellnessProvider.count(),
      ]);
      return { ...paged(rows.map((p) => ({ id: p.id, name: providerName(p), kind: p.organisation ? p.organisation.type : p.professional?.professionType, status: p.organisation?.status ?? p.professional?.verificationStatus, createdAt: p.createdAt,
        offerings: p.offerings.length, published: p.offerings.filter((o) => o.status === 'PUBLISHED').length, bookings: p.offerings.reduce((n, o) => n + o._count.bookings, 0) })), total, { page, limit }), counts };
    }
    if (view === 'offerings') {
      const where = status ? { status } : {};
      const [rows, total] = await Promise.all([
        prisma.wellnessOffering.findMany({ where, orderBy: { updatedAt: 'desc' }, skip, take: limit, include: { provider: providerSelect, _count: { select: { bookings: true } } } }),
        prisma.wellnessOffering.count({ where }),
      ]);
      return { ...paged(rows.map((o) => ({ id: o.id, name: o.name, category: o.category, priceMinor: o.priceMinor, status: o.status, updatedAt: o.updatedAt, provider: providerName(o.provider), bookings: o._count.bookings })), total, { page, limit }), counts };
    }
    const where = status ? { status } : {};
    const [rows, total] = await Promise.all([
      prisma.wellnessBooking.findMany({ where, orderBy: { requestedAt: 'desc' }, skip, take: limit, include: { patient: { select: { id: true, patientId: true, full_name: true } }, offering: { select: { name: true, category: true, priceMinor: true, provider: providerSelect } } } }),
      prisma.wellnessBooking.count({ where }),
    ]);
    const now = Date.now();
    return { ...paged(rows.map((b) => ({ id: b.id, status: b.status, requestedAt: b.requestedAt, decidedAt: b.decidedAt, decisionReason: b.decisionReason, patient: person(b.patient), offering: b.offering.name, category: b.offering.category, priceMinor: b.offering.priceMinor, provider: providerName(b.offering.provider), waitingTooLong: b.status === 'PENDING' && now - b.requestedAt.getTime() > 2 * DAY })), total, { page, limit }), counts };
  }));

// ------------------------------------------------------------------------------------------------
// Hospitals (Sabi Health side: member plans, enrolments, appointment requests)
// ------------------------------------------------------------------------------------------------
productRoutes.get('/hospitals', READ,
  listQuery({ view: z.enum(['enrollments', 'appointments', 'plans']).default('enrollments'), status: z.string().regex(/^[A-Z_]{3,20}$/).optional(), hospitalId: uuid.optional() }),
  handle(async (req) => {
    const { view, status, hospitalId, page, limit } = req.query;
    const skip = (page - 1) * limit;
    const now = Date.now();
    const scope = { ...(status ? { status } : {}), ...(hospitalId ? { hospitalId } : {}) };
    const [enrolCounts, apptCounts] = await Promise.all([
      prisma.hospitalEnrollment.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.hospitalAppointment.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const counts = { enrollments: Object.fromEntries(enrolCounts.map((c) => [c.status, c._count._all])), appointments: Object.fromEntries(apptCounts.map((c) => [c.status, c._count._all])) };
    if (view === 'plans') {
      const [rows, total] = await Promise.all([
        prisma.hospitalMemberPlan.findMany({ where: scope, orderBy: { updatedAt: 'desc' }, skip, take: limit, include: { hospital: { select: { id: true, name: true } }, _count: { select: { enrollments: true } } } }),
        prisma.hospitalMemberPlan.count({ where: scope }),
      ]);
      return { ...paged(rows.map((p) => ({ id: p.id, name: p.name, feeMinor: p.feeMinor, status: p.status, hospital: p.hospital, enrollments: p._count.enrollments, updatedAt: p.updatedAt, feeNote: 'Plan fee is set by the hospital; it is not collected through Sabi.' })), total, { page, limit }), counts };
    }
    if (view === 'appointments') {
      const [rows, total] = await Promise.all([
        prisma.hospitalAppointment.findMany({ where: scope, orderBy: { requestedAt: 'desc' }, skip, take: limit, include: { hospital: { select: { id: true, name: true } }, patient: { select: { id: true, patientId: true, full_name: true } } } }),
        prisma.hospitalAppointment.count({ where: scope }),
      ]);
      return { ...paged(rows.map((a) => ({ id: a.id, status: a.status, type: a.appointmentType, requestedAt: a.requestedAt, decidedAt: a.decidedAt, checkedInAt: a.checkedInAt, decisionReason: a.decisionReason, hospital: a.hospital, patient: person(a.patient), forDependent: Boolean(a.dependentId), waitingTooLong: a.status === 'PENDING' && now - a.requestedAt.getTime() > 2 * DAY })), total, { page, limit }), counts };
    }
    const [rows, total] = await Promise.all([
      prisma.hospitalEnrollment.findMany({ where: scope, orderBy: { createdAt: 'desc' }, skip, take: limit, include: { hospital: { select: { id: true, name: true } }, plan: { select: { name: true, feeMinor: true } }, patient: { select: { id: true, patientId: true, full_name: true } } } }),
      prisma.hospitalEnrollment.count({ where: scope }),
    ]);
    return { ...paged(rows.map((e) => ({ id: e.id, status: e.status, requestedAt: e.createdAt, decidedAt: e.decidedAt, decisionReason: e.decisionReason, hospital: e.hospital, plan: e.plan, patient: person(e.patient), forDependent: Boolean(e.dependentId), waitingTooLong: e.status === 'PENDING' && now - e.createdAt.getTime() > 2 * DAY })), total, { page, limit }), counts };
  }));

// ------------------------------------------------------------------------------------------------
// EMR tenants: which organisations use the EMR and how much (counts only, read inside each
// tenant's own row-level-security context — no clinical content leaves the tenant).
// ------------------------------------------------------------------------------------------------
async function tenantActivity(organizationId, since) {
  try {
    return await withTenant({ organizationId }, async (tx) => {
      const [patients, encounters, labOrders, invoices] = await Promise.all([
        tx.emrPatient.count({ where: { organizationId } }),
        tx.emrEncounter.count({ where: { organizationId, createdAt: { gte: since } } }),
        tx.emrLabOrder.count({ where: { organizationId, createdAt: { gte: since } } }),
        tx.emrInvoice.count({ where: { organizationId, createdAt: { gte: since } } }),
      ]);
      return { patients, encounters30d: encounters, labOrders30d: labOrders, invoices30d: invoices };
    });
  } catch {
    return null;
  }
}

async function organisationsWithEmr(types) {
  return prisma.identityOrganization.findMany({
    where: { ...(types ? { type: { in: types } } : { type: { not: 'PHARMACY' } }) },
    orderBy: { createdAt: 'desc' },
    select: { id: true, type: true, createdAt: true, organisation: { select: { id: true, name: true, city: true, state: true, status: true, approvedPlatformApplication: { select: { reference: true, status: true, setupCompletedAt: true, packageVersion: { select: { version: true, moduleKeys: true, package: { select: { name: true } } } } } } } },
      _count: { select: { memberships: { where: { status: 'ACTIVE' } } } } },
  });
}

productRoutes.get('/emr/tenants', READ, validate(z.object({ query: none, params: none }).passthrough()),
  handle(async () => {
    const since = new Date(Date.now() - 30 * DAY);
    const [orgs, dead] = await Promise.all([
      organisationsWithEmr(null),
      withWorker((tx) => tx.emrWebhookDelivery.groupBy({ by: ['organizationId'], where: { status: 'DEAD' }, _count: { _all: true } })),
    ]);
    const deadBy = new Map(dead.map((d) => [d.organizationId, d._count._all]));
    const live = new Map(metricsSnapshot().map((m) => [m.organizationId, m]));
    const items = [];
    for (const o of orgs.slice(0, 100)) {
      const app = o.organisation?.approvedPlatformApplication;
      const emrEnabled = Boolean(app?.packageVersion.moduleKeys.includes('emr'));
      items.push({
        organizationId: o.id, name: o.organisation?.name ?? 'Unnamed', type: o.type, city: o.organisation?.city, status: o.organisation?.status, since: o.createdAt,
        package: app ? `${app.packageVersion.package.name} v${app.packageVersion.version}` : null, emrEnabled, goLive: app?.setupCompletedAt ?? null, activeMembers: o._count.memberships,
        activity: emrEnabled ? await tenantActivity(o.id, since) : null, deadWebhooks: deadBy.get(o.id) ?? 0,
        apiSinceRestart: live.get(o.id) ?? null,
      });
    }
    return { generatedAt: new Date().toISOString(), note: 'Counts only. Patient records and clinical content stay inside each hospital and are never read here.', items };
  }));

productRoutes.get('/laboratories', READ, validate(z.object({ query: none, params: none }).passthrough()),
  handle(async () => {
    const [orgs, registered] = await Promise.all([
      organisationsWithEmr(['LABORATORY', 'DIAGNOSTIC_CENTRE']),
      prisma.organisation.findMany({ where: { type: { in: ['LABORATORY', 'DIAGNOSTIC_CENTRE'] } }, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, type: true, city: true, state: true, status: true, createdAt: true, decidedAt: true, decisionNote: true } }),
    ]);
    const since = new Date(Date.now() - 30 * DAY);
    const withEmr = new Map(orgs.map((o) => [o.organisation?.id, o]));
    const items = [];
    for (const r of registered) {
      const tenant = withEmr.get(r.id);
      items.push({ ...r, organizationId: tenant?.id ?? null, activeMembers: tenant?._count.memberships ?? 0, activity: tenant ? await tenantActivity(tenant.id, since) : null });
    }
    return { generatedAt: new Date().toISOString(), items };
  }));

// ------------------------------------------------------------------------------------------------
// Verification queue: every decision waiting on Sabi, oldest first
// ------------------------------------------------------------------------------------------------
productRoutes.get('/verification', allow('platform.ops.read', 'platform.onboarding.review', 'platform.pharmacy.manage', 'platform.providers.manage'),
  validate(z.object({ query: none, params: none }).passthrough()),
  handle(async () => {
    const [doctors, pharmacies, listings, organisations, applications, offerings] = await Promise.all([
      prisma.professionalProfile.findMany({ where: { doctorApplication: { stage: { in: ['SUBMITTED', 'PENDING_REVIEW'] } } }, select: { id: true, professionType: true, user: { select: { full_name: true } }, doctorApplication: { select: { submittedAt: true, stage: true } } } }),
      prisma.pharmacy.findMany({ where: { complianceStatus: 'PENDING', applicationSubmittedAt: { not: null } }, select: { id: true, name: true, city: true, applicationSubmittedAt: true } }),
      prisma.pharmacyListing.findMany({ where: { status: 'SUBMITTED' }, select: { id: true, updatedAt: true, inventoryItem: { select: { medicationName: true, pharmacy: { select: { name: true } } } } } }),
      prisma.organisation.findMany({ where: { status: 'PENDING' }, select: { id: true, name: true, type: true, createdAt: true } }),
      prisma.platformApplication.findMany({ where: { status: { in: ['SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFORMATION'] } }, select: { id: true, reference: true, organizationName: true, status: true, submittedAt: true, createdAt: true } }),
      prisma.wellnessOffering.count({ where: { status: 'DRAFT' } }),
    ]);
    const item = (kind, id, title, subtitle, since, href) => ({ kind, id, title, subtitle, since, href });
    const items = [
      ...doctors.map((d) => item('Doctor application', d.id, d.user.full_name ?? 'Unnamed', `${d.professionType} · ${d.doctorApplication.stage.toLowerCase().replace('_', ' ')}`, d.doctorApplication.submittedAt, 'doctors')),
      ...pharmacies.map((p) => item('Pharmacy application', p.id, p.name, p.city, p.applicationSubmittedAt, 'pharmacies')),
      ...listings.map((l) => item('Product listing', l.id, l.inventoryItem.medicationName, l.inventoryItem.pharmacy.name, l.updatedAt, 'listings')),
      ...organisations.map((o) => item('Organisation', o.id, o.name, o.type.toLowerCase().replace('_', ' '), o.createdAt, 'organizations')),
      ...applications.map((a) => item('Sabi OS application', a.id, a.organizationName, `${a.reference} · ${a.status.toLowerCase().replace('_', ' ')}`, a.submittedAt ?? a.createdAt, 'onboarding')),
    ].sort((a, b) => (a.since?.getTime() ?? 0) - (b.since?.getTime() ?? 0));
    return { generatedAt: new Date().toISOString(), items, draftWellnessOfferings: offerings, note: 'Rider applications are reviewed on the Riders page.' };
  }));

// ------------------------------------------------------------------------------------------------
// Waitlist
// ------------------------------------------------------------------------------------------------
productRoutes.get('/waitlist', READ,
  listQuery({ product: z.string().trim().max(40).optional(), ...rangeQuery }),
  handle(async (req) => {
    const { product, page, limit } = req.query;
    const where = { ...(product ? { product } : {}), ...rangeWhere(req.query) };
    const [rows, total, byProduct, byRole] = await Promise.all([
      prisma.waitlistSignup.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
      prisma.waitlistSignup.count({ where }),
      prisma.waitlistSignup.groupBy({ by: ['product'], _count: { _all: true } }),
      prisma.waitlistSignup.groupBy({ by: ['role'], where, _count: { _all: true } }),
    ]);
    return {
      ...paged(rows.map((w) => ({ id: w.id, product: w.product, email: maskEmail(w.email), name: w.fullName, role: w.role, organisation: w.organisation, source: w.source, consentedAt: w.consentedAt, createdAt: w.createdAt })), total, { page, limit }),
      byProduct: Object.fromEntries(byProduct.map((r) => [r.product, r._count._all])), byRole: Object.fromEntries(byRole.map((r) => [r.role, r._count._all])),
    };
  }));
