// /api/v1/command-centre/patients — the unified patient/account view for Sabi staff.
//
// Three levels, each audited on the patient's own Activity log ("Sabi staff opened …"):
//   list      platform.patients.read  masked contact details, no clinical data
//   account   platform.patients.read  + a stated reason: identity, sessions, sign-in locations,
//                                     addresses, care circle, orders, payments, consents
//   clinical  platform.clinical.read  + a stated reason (or an active emergency grant):
//                                     consultations, prescribed / purchased / handed over /
//                                     patient-reported medicines, allergies, conditions, documents
// Hospital EMR records stay inside each hospital's tenant (row-level security); this view shows
// only what Sabi itself holds and says so.
import express from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { requireRecentMfa } from '../../middleware/mfaMiddleware.js';
import { maskIp } from '../audit/audit.context.js';
import { decryptDeliveryDetails } from '../orders/orders.delivery.js';
import { adminAudit, allow, can, ccError, deviceName, handle, maskEmail, maskPhone, namesFor, pageQuery, paged, reason } from './cc.common.js';

export const patientRoutes = express.Router();
export const emergencyRoutes = express.Router();

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid }).strict();
const none = z.object({}).strict();
const LOCATION_NOTE = 'Sabi does not track where patients are. Locations below are approximate, derived from the network (IP) address at each sign-in, and are shown with the time they were recorded. None of them is a current location.';

async function patientOr404(id) {
  const user = await prisma.user.findFirst({
    where: { id, roles: { some: { role: 'PATIENT' } } },
    select: { id: true, patientId: true, full_name: true, email: true, phone_number: true, dob: true, accountStatus: true, emailVerifiedAt: true, phoneVerifiedAt: true, lastLoginAt: true, roles: { select: { role: true } }, profile: true, mfaTotp: { select: { enabledAt: true } } },
  });
  if (!user) throw ccError('NOT_FOUND', 404, 'Patient not found.');
  return user;
}

// ------------------------------------------------------------------------------------------------
// List / search (masked)
// ------------------------------------------------------------------------------------------------
patientRoutes.get('/', allow('platform.patients.read'),
  validate(z.object({
    query: z.object({ q: z.string().trim().max(120).optional(), status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'LOCKED', 'DISABLED', 'DEACTIVATED', 'BANNED']).optional(), ...pageQuery }).strict(),
    params: none,
  }).passthrough()),
  handle(async (req) => {
    const { q, status, page, limit } = req.query;
    const where = {
      roles: { some: { role: 'PATIENT' } },
      ...(status ? { accountStatus: status } : {}),
      ...(q ? { OR: [
        { full_name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { patientId: { contains: q, mode: 'insensitive' } },
        { phone_number: { contains: q.replace(/[^\d+]/g, '') || q } },
      ] } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.user.findMany({ where, orderBy: [{ lastLoginAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }], skip: (page - 1) * limit, take: limit,
        select: { id: true, patientId: true, full_name: true, email: true, phone_number: true, accountStatus: true, lastLoginAt: true, emailVerifiedAt: true } }),
      prisma.user.count({ where }),
    ]);
    return paged(rows.map((u) => ({
      id: u.id, patientId: u.patientId, name: u.full_name, email: maskEmail(u.email), phone: maskPhone(u.phone_number),
      accountStatus: u.accountStatus, emailVerified: Boolean(u.emailVerifiedAt), lastSignInAt: u.lastLoginAt,
    })), total, { page, limit });
  }));

// ------------------------------------------------------------------------------------------------
// Account view (reason required)
// ------------------------------------------------------------------------------------------------
async function accountView(user) {
  const id = user.id;
  const [sessions, signIns, orders, careCircle, caregiving, doctors, dependents, consents, shares, enrolments, cases] = await Promise.all([
    prisma.authSession.findMany({ where: { userId: id }, orderBy: { lastUsedAt: 'desc' }, take: 20, include: { device: { select: { label: true, firstSeenAt: true, lastSeenAt: true } } } }),
    prisma.auditEvent.findMany({ where: { actorUserId: id, category: 'SIGN_IN' }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.order.findMany({ where: { patientId: id }, orderBy: { createdAt: 'desc' }, take: 50,
      include: { paymentAttempts: { orderBy: { createdAt: 'desc' }, select: { id: true, provider: true, providerReference: true, status: true, amountMinor: true, createdAt: true, completedAt: true } },
        fulfilments: { select: { id: true, status: true, fulfilmentMethod: true, totalMinor: true, pharmacy: { select: { id: true, name: true } } } } } }),
    prisma.careRelationship.findMany({ where: { patientId: id }, orderBy: { createdAt: 'desc' }, include: { caregiver: { select: { id: true, full_name: true } } } }),
    prisma.careRelationship.findMany({ where: { caregiverId: id }, orderBy: { createdAt: 'desc' }, include: { patient: { select: { id: true, full_name: true } } } }),
    prisma.doctorCareRelationship.findMany({ where: { patientId: id }, orderBy: { requestedAt: 'desc' }, include: { doctorProfile: { select: { id: true, specialty: true, user: { select: { full_name: true } } } } } }),
    prisma.dependentProfile.findMany({ where: { patientId: id }, select: { id: true, fullName: true, dateOfBirth: true, createdAt: true } }),
    prisma.professionalCareConsent.findMany({ where: { patientId: id }, include: { professional: { select: { id: true, professionType: true, user: { select: { full_name: true } } } } } }),
    prisma.medicalDocumentShare.findMany({ where: { document: { ownerPatientId: id } }, orderBy: { createdAt: 'desc' }, take: 20, include: { recipient: { select: { full_name: true } }, document: { select: { kind: true } } } }),
    prisma.hospitalEnrollment.findMany({ where: { patientId: id }, orderBy: { createdAt: 'desc' }, include: { hospital: { select: { id: true, name: true } } } }),
    prisma.opsCase.findMany({ where: { subjectUserId: id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, reference: true, kind: true, title: true, status: true, priority: true, createdAt: true } }),
  ]);

  // Delivery addresses the patient typed at checkout: newest first, with the order and time.
  const addresses = [];
  for (const order of orders) {
    if (!order.encryptedDeliveryDetails) continue;
    try {
      const details = decryptDeliveryDetails(order.encryptedDeliveryDetails);
      addresses.push({ address: details.address, recipientName: details.recipientName, recipientPhone: details.recipientPhone, source: `Delivery details given at checkout for order ${order.reference}`, recordedAt: order.createdAt, orderId: order.id });
    } catch {
      addresses.push({ address: null, source: `Delivery details for order ${order.reference} could not be decrypted on this server`, recordedAt: order.createdAt, orderId: order.id, unavailable: true });
    }
  }
  const p = user.profile;
  if (p?.emergencyContactName || p?.emergencyContactPhone) {
    addresses.push({ kind: 'EMERGENCY_CONTACT', recipientName: p.emergencyContactName, recipientPhone: p.emergencyContactPhone, relation: p.emergencyContactRelation, source: 'Emergency contact on the patient profile', recordedAt: p.updated_at, recordedAtNote: 'Time of the last profile update (field-level history is not kept)' });
  }

  const now = new Date();
  return {
    account: {
      id: user.id, patientId: user.patientId, name: user.full_name, email: user.email, phone: user.phone_number, dateOfBirth: user.dob,
      accountStatus: user.accountStatus, emailVerifiedAt: user.emailVerifiedAt, phoneVerifiedAt: user.phoneVerifiedAt,
      lastSignInAt: user.lastLoginAt, twoStepVerification: Boolean(user.mfaTotp?.enabledAt), roles: user.roles.map((r) => r.role),
    },
    sessions: sessions.map((s) => ({
      id: s.id, device: deviceName(s.device.label), startedAt: s.createdAt, lastActiveAt: s.lastUsedAt, expiresAt: s.expiresAt,
      state: s.revokedAt ? 'SIGNED_OUT' : s.expiresAt <= now ? 'EXPIRED' : 'ACTIVE', endedAt: s.revokedAt, endedReason: s.revokedReason, twoStepVerifiedAt: s.mfaVerifiedAt,
    })),
    location: {
      current: null,
      note: LOCATION_NOTE,
      signIns: signIns.map((e) => ({
        at: e.createdAt, action: e.action, device: e.device, ip: maskIp(e.ipAddress),
        approximateLocation: e.city || e.region || e.country ? { city: e.city, region: e.region, country: e.country, source: 'IP address at sign-in', recordedAt: e.createdAt } : null,
      })),
    },
    addresses,
    careCircle: {
      caregivers: careCircle.map((c) => ({ id: c.id, name: c.caregiver?.full_name ?? null, invitedEmail: maskEmail(c.caregiverEmail), relationship: c.relationshipLabel || c.relationshipType, permissions: c.permissions, status: c.status, since: c.respondedAt ?? c.createdAt, accessExpiresAt: c.accessExpiresAt, revokedAt: c.revokedAt })),
      caresFor: caregiving.map((c) => ({ id: c.id, name: c.patient.full_name, relationship: c.relationshipLabel || c.relationshipType, status: c.status, since: c.respondedAt ?? c.createdAt })),
      doctors: doctors.map((d) => ({ id: d.id, doctor: d.doctorProfile.user.full_name, specialty: d.doctorProfile.specialty, status: d.status, requestedAt: d.requestedAt, respondedAt: d.respondedAt, revokedAt: d.revokedAt, expiresAt: d.expiresAt })),
      dependents: dependents.map((d) => ({ id: d.id, name: d.fullName, dateOfBirth: d.dateOfBirth, addedAt: d.createdAt })),
      hospitals: enrolments.map((e) => ({ id: e.id, hospital: e.hospital.name, status: e.status, requestedAt: e.createdAt, decidedAt: e.decidedAt })),
    },
    orders: orders.map((o) => ({
      id: o.id, reference: o.reference, status: o.status, totalPayableMinor: o.totalPayableMinor, deliveryFeeMinor: o.deliveryFeeMinor, createdAt: o.createdAt,
      fulfilments: o.fulfilments.map((f) => ({ id: f.id, pharmacy: f.pharmacy.name, method: f.fulfilmentMethod, status: f.status, totalMinor: f.totalMinor })),
    })),
    payments: orders.flatMap((o) => o.paymentAttempts.map((a) => ({ ...a, orderId: o.id, orderReference: o.reference }))),
    consents: {
      platform: p ? [
        { key: 'termsAndPrivacy', label: 'Terms and privacy consent', given: p.consentGiven, at: p.consentGivenAt },
        { key: 'dataSharing', label: 'Share data for research and service improvement', given: Boolean(p.data_sharing_consent), at: p.dataSharingConsentAt },
        { key: 'electronicRecords', label: 'Keep electronic health records', given: Boolean(p.electronic_health_records), at: p.electronicHealthRecordsAt },
        { key: 'emergencyCard', label: 'Emergency Card sharing', given: p.emergencySharingEnabled, at: p.emergencyConsentedAt, detail: { circle: p.emergencyCircleEnabled, hospitals: p.emergencyHospitalsEnabled, consentVersion: p.emergencyConsentVersion } },
      ] : [],
      professionals: consents.map((c) => ({ id: c.id, professional: c.professional.user.full_name, professionType: c.professional.professionType, active: c.active, grantedAt: c.grantedAt, revokedAt: c.revokedAt })),
      documentShares: shares.map((s) => ({ id: s.id, recipient: s.recipient.full_name, documentKind: s.document.kind, sharedAt: s.createdAt, expiresAt: s.expiresAt, revokedAt: s.revokedAt })),
    },
    cases,
  };
}

const openBody = z.object({ body: z.object({ reason }).strict(), query: none, params: idParams });

patientRoutes.post('/:id/account', allow('platform.patients.read'), validate(openBody),
  handle(async (req) => {
    const user = await patientOr404(req.params.id);
    await adminAudit(prisma, req, { action: 'ADMIN_PATIENT_VIEWED', summary: `Opened the account profile of ${user.patientId}`, subjectUserId: user.id, resourceType: 'patient', resourceId: user.id, reason: req.body.reason });
    return { ...(await accountView(user)), openedAt: new Date().toISOString() };
  }));

// ------------------------------------------------------------------------------------------------
// Clinical view (clinical permission or an active emergency grant, plus a reason)
// ------------------------------------------------------------------------------------------------
async function activeGrant(actorUserId, subjectUserId, now = new Date()) {
  return prisma.emergencyAccessGrant.findFirst({ where: { actorUserId, subjectUserId, endedAt: null, expiresAt: { gt: now } }, orderBy: { expiresAt: 'desc' } });
}

async function clinicalView(user) {
  const id = user.id;
  const [appointments, prescriptions, purchases, reported, schedules, documents, vitals] = await Promise.all([
    prisma.doctorAppointment.findMany({ where: { patientId: id }, orderBy: { startsAt: 'desc' }, take: 50,
      include: { doctorProfile: { select: { id: true, specialty: true, user: { select: { full_name: true } } } }, consultationNote: { select: { signedVersion: true, updatedAt: true } }, videoRoom: { select: { createdAt: true } } } }),
    prisma.prescription.findMany({ where: { patientId: id, status: { not: 'DRAFT' } }, orderBy: { createdAt: 'desc' }, take: 50,
      include: { items: true, doctorProfile: { select: { user: { select: { full_name: true } } } } } }),
    prisma.orderAllocation.findMany({ where: { fulfilment: { order: { patientId: id, status: 'PAID' } } }, orderBy: { fulfilment: { createdAt: 'desc' } }, take: 200,
      include: { fulfilment: { select: { id: true, status: true, fulfilmentMethod: true, createdAt: true, pharmacy: { select: { name: true } }, order: { select: { id: true, reference: true } }, deliveryAssignments: { where: { deliveredAt: { not: null } }, select: { deliveredAt: true } } } } } }),
    prisma.medication.findMany({ where: { userId: id }, orderBy: { updatedAt: 'desc' } }),
    prisma.medicationSchedule.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.medicalDocument.findMany({ where: { ownerPatientId: id, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, kind: true, status: true, createdAt: true } }),
    prisma.vital.findMany({ where: { userId: id }, orderBy: { recordedAt: 'desc' }, take: 20 }),
  ]);
  const handedOver = (f) => ['PICKED_UP', 'DELIVERED'].includes(f.status);
  const purchaseRows = purchases.map((a) => ({
    medicationName: a.medicationName, quantity: a.selectedQuantity, prescriptionItemId: a.prescriptionItemId, orderId: a.fulfilment.order.id, orderReference: a.fulfilment.order.reference,
    pharmacy: a.fulfilment.pharmacy.name, method: a.fulfilment.fulfilmentMethod, fulfilmentStatus: a.fulfilment.status, purchasedAt: a.fulfilment.createdAt,
    handedOver: handedOver(a.fulfilment), handedOverAt: a.fulfilment.deliveryAssignments[0]?.deliveredAt ?? null,
  }));
  const p = user.profile;
  return {
    consultations: appointments.map((a) => ({
      id: a.id, doctor: a.doctorProfile.user.full_name, specialty: a.doctorProfile.specialty, type: a.consultationType, status: a.status,
      startsAt: a.startsAt, endsAt: a.endsAt, requestedAt: a.createdAt, confirmedAt: a.confirmedAt, completedAt: a.completedAt, cancelledAt: a.cancelledAt, cancelledBy: a.cancelledBy,
      videoRoomCreatedAt: a.videoRoom?.createdAt ?? null, noteSigned: Boolean(a.consultationNote?.signedVersion),
    })),
    medicines: {
      definitions: {
        prescribed: 'Issued by a Sabi doctor (prescription items).',
        purchased: 'Bought through the Sabi marketplace and paid for (order lines).',
        handedOver: 'Purchased lines whose fulfilment was picked up or delivered (handover confirmed with a code).',
        patientReported: 'Entered by the patient: their medicine list, reminder schedules and the free-text field on their profile. Not verified by a clinician.',
      },
      prescribed: prescriptions.flatMap((rx) => rx.items.map((item) => {
        const bought = purchaseRows.filter((r) => r.prescriptionItemId === item.id);
        return {
          prescriptionId: rx.id, reference: rx.reference, status: rx.status, issuedAt: rx.issuedAt, cancelledAt: rx.cancelledAt, prescriber: rx.doctorProfile.user.full_name,
          itemId: item.id, medicationName: item.medicationName, dosage: item.dosage, frequency: item.frequency, route: item.route, duration: item.duration, quantity: item.quantity,
          purchasedQuantity: bought.reduce((n, r) => n + r.quantity, 0), handedOverQuantity: bought.filter((r) => r.handedOver).reduce((n, r) => n + r.quantity, 0),
        };
      })),
      purchased: purchaseRows,
      patientReported: [
        ...reported.map((m) => ({ source: 'Patient medicine list', name: m.name, instructions: m.instructions, recordedAt: m.updatedAt })),
        ...schedules.map((s) => ({ source: s.source === 'PRESCRIPTION' ? 'Reminder schedule (from a Sabi prescription)' : 'Reminder schedule (added by the patient)', name: s.name, dosage: s.dosage, status: s.status, startDate: s.startDate, endDate: s.endDate, recordedAt: s.createdAt })),
        ...(p?.current_medications ? [{ source: 'Profile free text', name: p.current_medications, recordedAt: p.updated_at, recordedAtNote: 'Time of the last profile update' }] : []),
      ],
    },
    allergies: {
      reported: p?.known_allergies ? [{ text: p.known_allergies, source: 'Patient profile (self-reported)', verification: 'UNVERIFIED', recordedAt: p.updated_at, recordedAtNote: 'Time of the last profile update' }] : [],
      clinicianVerified: [],
      note: 'Clinician-verified allergies are recorded in hospital EMRs, which stay within each hospital (Sabi staff cannot read them). Only what the patient reported to Sabi is shown.',
    },
    conditions: p?.chronic_conditions ? [{ text: p.chronic_conditions, source: 'Patient profile (self-reported)', recordedAt: p.updated_at }] : [],
    health: { bloodType: p?.blood_type ?? null, genotype: p?.genotype ?? null, recentVitals: vitals.map((v) => ({ type: v.type, value: v.value, unit: v.unit, status: v.status, recordedAt: v.recordedAt, source: 'Patient-entered' })) },
    documents: documents.map((d) => ({ ...d, note: 'Contents are not opened from the Command Centre.' })),
    labResults: {
      items: documents.filter((d) => d.kind === 'LAB_RESULT').map((d) => ({ id: d.id, status: d.status, uploadedAt: d.createdAt, source: 'Uploaded by the patient' })),
      note: 'Hospital laboratory results stay in the hospital EMR. Lab results the patient uploaded to Sabi are listed (metadata only).',
    },
  };
}

patientRoutes.post('/:id/clinical', allow('platform.clinical.read', 'platform.emergency.access'), validate(openBody),
  handle(async (req) => {
    const user = await patientOr404(req.params.id);
    const grant = can(req, 'platform.clinical.read') ? null : await activeGrant(req.user.id, user.id);
    if (!can(req, 'platform.clinical.read') && !grant) {
      throw ccError('EMERGENCY_ACCESS_REQUIRED', 403, 'Your role cannot open health information. Start emergency access for this patient if it is urgent; it will be reviewed.');
    }
    await adminAudit(prisma, req, {
      action: 'ADMIN_CLINICAL_VIEWED', summary: `Opened health information of ${user.patientId}${grant ? ' under emergency access' : ''}`,
      subjectUserId: user.id, resourceType: 'patient', resourceId: user.id, reason: req.body.reason, extra: grant ? { emergencyGrantId: grant.id } : undefined,
    });
    return { ...(await clinicalView(user)), openedAt: new Date().toISOString(), access: grant ? { kind: 'EMERGENCY', grantId: grant.id, expiresAt: grant.expiresAt } : { kind: 'ROLE' } };
  }));

// ------------------------------------------------------------------------------------------------
// Access history: who opened or changed this person's record (newest first)
// ------------------------------------------------------------------------------------------------
patientRoutes.get('/:id/access-history', allow('platform.patients.read', 'platform.audit.read'),
  validate(z.object({ query: z.object({ ...pageQuery, staffOnly: z.enum(['true', 'false']).optional() }).strict(), params: idParams }).passthrough()),
  handle(async (req) => {
    const user = await patientOr404(req.params.id);
    const { page, limit } = req.query;
    const where = {
      subjectUserId: user.id,
      ...(req.query.staffOnly === 'true' ? { category: 'ADMIN' } : { category: { in: ['ADMIN', 'RECORD_ACCESS', 'RECORD_CHANGE', 'PERMISSION'] } }),
    };
    const [rows, total] = await Promise.all([
      prisma.auditEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
      prisma.auditEvent.count({ where }),
    ]);
    const names = await namesFor(prisma, rows.map((r) => r.actorUserId));
    return paged(rows.map((r) => ({
      id: r.id, at: r.createdAt, category: r.category, action: r.action, summary: r.summary, actor: names.get(r.actorUserId) ?? 'Unknown', actorUserId: r.actorUserId,
      byStaff: r.category === 'ADMIN', reason: r.context?.reason ?? null, roles: r.context?.roles ?? null, device: r.device, ip: maskIp(r.ipAddress),
    })), total, { page, limit });
  }));

// ------------------------------------------------------------------------------------------------
// Emergency (break-glass) access
// ------------------------------------------------------------------------------------------------
patientRoutes.post('/:id/emergency-access', allow('platform.emergency.access'), requireRecentMfa,
  validate(z.object({ body: z.object({ reason: z.string().trim().min(20, 'Describe the emergency in at least 20 characters').max(500), minutes: z.number().int().min(5).max(60).default(30) }).strict(), query: none, params: idParams })),
  handle(async (req, res) => {
    const user = await patientOr404(req.params.id);
    if (user.id === req.user.id) throw ccError('INVALID_STATE', 409, 'You cannot use emergency access on your own record.');
    const grant = await prisma.$transaction(async (tx) => {
      const existing = await tx.emergencyAccessGrant.findFirst({ where: { actorUserId: req.user.id, subjectUserId: user.id, endedAt: null, expiresAt: { gt: new Date() } } });
      if (existing) throw ccError('INVALID_STATE', 409, 'You already have emergency access to this patient.', { grantId: existing.id, expiresAt: existing.expiresAt });
      const started = new Date();
      const created = await tx.emergencyAccessGrant.create({ data: { actorUserId: req.user.id, subjectUserId: user.id, reason: req.body.reason, startedAt: started, expiresAt: new Date(started.getTime() + req.body.minutes * 60_000) } });
      await adminAudit(tx, req, { action: 'ADMIN_EMERGENCY_ACCESS_STARTED', summary: `Started ${req.body.minutes}-minute emergency access to ${user.patientId}`, subjectUserId: user.id, resourceType: 'emergency_access', resourceId: created.id, reason: req.body.reason });
      return created;
    });
    res.status(201);
    return grant;
  }));

emergencyRoutes.get('/', allow('platform.audit.read', 'platform.emergency.access'),
  validate(z.object({ query: z.object({ ...pageQuery, unreviewed: z.enum(['true', 'false']).optional() }).strict(), params: none }).passthrough()),
  handle(async (req) => {
    const { page, limit } = req.query;
    // Without audit.read a person sees only their own grants.
    const where = { ...(can(req, 'platform.audit.read') ? {} : { actorUserId: req.user.id }), ...(req.query.unreviewed === 'true' ? { reviewedAt: null } : {}) };
    const [rows, total] = await Promise.all([
      prisma.emergencyAccessGrant.findMany({ where, orderBy: { startedAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.emergencyAccessGrant.count({ where }),
    ]);
    const names = await namesFor(prisma, rows.flatMap((g) => [g.actorUserId, g.subjectUserId, g.reviewedByUserId]));
    const now = new Date();
    return paged(rows.map((g) => ({
      ...g, actor: names.get(g.actorUserId), subject: names.get(g.subjectUserId), reviewer: names.get(g.reviewedByUserId) ?? null,
      state: g.endedAt ? 'ENDED' : g.expiresAt <= now ? 'EXPIRED' : 'ACTIVE',
    })), total, { page, limit });
  }));

emergencyRoutes.post('/:id/end', allow('platform.emergency.access'),
  validate(z.object({ body: none.optional(), query: none, params: idParams })),
  handle(async (req) => prisma.$transaction(async (tx) => {
    const grant = await tx.emergencyAccessGrant.findFirst({ where: { id: req.params.id, actorUserId: req.user.id } });
    if (!grant) throw ccError('NOT_FOUND', 404, 'Emergency access not found.');
    if (grant.endedAt || grant.expiresAt <= new Date()) throw ccError('INVALID_STATE', 409, 'This emergency access has already ended.');
    const ended = await tx.emergencyAccessGrant.update({ where: { id: grant.id }, data: { endedAt: new Date() } });
    await adminAudit(tx, req, { action: 'ADMIN_EMERGENCY_ACCESS_ENDED', summary: 'Ended emergency access', subjectUserId: grant.subjectUserId, resourceType: 'emergency_access', resourceId: grant.id });
    return ended;
  })));

emergencyRoutes.post('/:id/review', allow('platform.audit.read'),
  validate(z.object({ body: z.object({ outcome: z.enum(['APPROPRIATE', 'INAPPROPRIATE']), note: reason }).strict(), query: none, params: idParams })),
  handle(async (req) => prisma.$transaction(async (tx) => {
    const grant = await tx.emergencyAccessGrant.findUnique({ where: { id: req.params.id } });
    if (!grant) throw ccError('NOT_FOUND', 404, 'Emergency access not found.');
    if (grant.actorUserId === req.user.id) throw ccError('SAME_PERSON', 403, 'Someone else must review your own emergency access.');
    if (grant.reviewedAt) throw ccError('INVALID_STATE', 409, 'This emergency access has already been reviewed.');
    if (!grant.endedAt && grant.expiresAt > new Date()) throw ccError('INVALID_STATE', 409, 'Review emergency access after it has ended.');
    const reviewed = await tx.emergencyAccessGrant.update({ where: { id: grant.id }, data: { reviewedByUserId: req.user.id, reviewedAt: new Date(), reviewOutcome: req.body.outcome, reviewNote: req.body.note } });
    await adminAudit(tx, req, { summary: `Reviewed emergency access as ${req.body.outcome.toLowerCase()}`, resourceType: 'emergency_access', resourceId: grant.id, reason: req.body.note, after: { outcome: req.body.outcome } });
    return reviewed;
  })));

// ------------------------------------------------------------------------------------------------
// Sign the patient out everywhere (e.g. a reported lost phone). Account suspension stays on the
// existing PATCH /api/v1/platform/users/:id/status (platform.users.manage), which also revokes.
// ------------------------------------------------------------------------------------------------
patientRoutes.post('/:id/sessions/revoke', allow('platform.users.manage'), requireRecentMfa, validate(openBody),
  handle(async (req) => {
    const user = await patientOr404(req.params.id);
    return prisma.$transaction(async (tx) => {
      const now = new Date();
      const revoked = await tx.authSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now, revokedReason: 'ADMIN' } });
      await tx.authRefreshCredential.updateMany({ where: { session: { userId: user.id }, revokedAt: null }, data: { revokedAt: now } });
      await tx.refreshToken.deleteMany({ where: { userId: user.id } });
      await adminAudit(tx, req, { action: 'ADMIN_ACCOUNT_CHANGED', summary: `Signed ${user.patientId} out of ${revoked.count} session(s)`, subjectUserId: user.id, resourceType: 'patient', resourceId: user.id, reason: req.body.reason, after: { sessionsRevoked: revoked.count } });
      return { sessionsRevoked: revoked.count };
    });
  }));
