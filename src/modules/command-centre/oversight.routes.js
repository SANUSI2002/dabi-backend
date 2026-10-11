// /api/v1/command-centre/consultations and /providers — consultation oversight (status and
// timeline, never note content) and provider credential oversight (licence expiry across doctors,
// pharmacies and branches; suspend / reinstate doctors with a recorded reason). Pharmacy suspension
// stays on POST /api/v1/platform/pharmacies/:id/decision, which also updates branches and emails.
import express from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { requireRecentMfa } from '../../middleware/mfaMiddleware.js';
import { adminAudit, allow, ccError, handle, namesFor, pageQuery, paged, rangeQuery, rangeWhere, reason } from './cc.common.js';

export const consultationRoutes = express.Router();
export const providerRoutes = express.Router();

const none = z.object({}).strict();
const DAY = 86_400_000;

consultationRoutes.get('/', allow('platform.ops.read'),
  validate(z.object({
    query: z.object({
      status: z.enum(['REQUESTED', 'CONFIRMED', 'DECLINED', 'CANCELLED', 'COMPLETED']).optional(),
      type: z.enum(['VIRTUAL', 'IN_PERSON']).optional(),
      doctorProfileId: z.string().uuid().optional(),
      patientId: z.string().uuid().optional(),
      attention: z.enum(['overdue-confirmation', 'not-completed', 'unsigned-note']).optional(),
      ...rangeQuery, ...pageQuery,
    }).strict(),
    params: none,
  }).passthrough()),
  handle(async (req) => {
    const { status, type, doctorProfileId, patientId, attention, page, limit } = req.query;
    const now = new Date();
    const attentionWhere = {
      // Requested more than a day ago and still unanswered.
      'overdue-confirmation': { status: 'REQUESTED', createdAt: { lt: new Date(now - DAY) } },
      // Confirmed, ended over two hours ago, not marked completed.
      'not-completed': { status: 'CONFIRMED', endsAt: { lt: new Date(now - 2 * 3_600_000) } },
      // Completed but the doctor has not signed the note.
      'unsigned-note': { status: 'COMPLETED', OR: [{ consultationNote: null }, { consultationNote: { signedVersion: null } }] },
    };
    const where = {
      ...rangeWhere(req.query, 'startsAt'),
      ...(status ? { status } : {}), ...(type ? { consultationType: type } : {}), ...(doctorProfileId ? { doctorProfileId } : {}), ...(patientId ? { patientId } : {}),
      ...(attention ? attentionWhere[attention] : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.doctorAppointment.findMany({ where, orderBy: [{ startsAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit,
        include: { patient: { select: { id: true, patientId: true, full_name: true } }, doctorProfile: { select: { id: true, specialty: true, user: { select: { full_name: true } } } }, consultationNote: { select: { signedVersion: true } } } }),
      prisma.doctorAppointment.count({ where }),
    ]);
    return paged(rows.map((a) => ({
      id: a.id, status: a.status, type: a.consultationType, startsAt: a.startsAt, endsAt: a.endsAt, requestedAt: a.createdAt,
      patient: { id: a.patient.id, patientId: a.patient.patientId, name: a.patient.full_name },
      doctor: { profileId: a.doctorProfile.id, name: a.doctorProfile.user.full_name, specialty: a.doctorProfile.specialty },
      noteSigned: Boolean(a.consultationNote?.signedVersion), forDependent: Boolean(a.dependentId),
    })), total, { page, limit });
  }));

consultationRoutes.get('/:id', allow('platform.ops.read'),
  validate(z.object({ query: none, params: z.object({ id: z.string().uuid() }).strict() }).passthrough()),
  handle(async (req) => {
    const a = await prisma.doctorAppointment.findUnique({
      where: { id: req.params.id },
      include: {
        patient: { select: { id: true, patientId: true, full_name: true } },
        doctorProfile: { select: { id: true, specialty: true, user: { select: { full_name: true } } } },
        slot: { select: { startsAt: true, endsAt: true } },
        videoRoom: { select: { createdAt: true, expiresAt: true, revokedAt: true } },
        consultationNote: { select: { revision: true, signedVersion: true, createdAt: true, updatedAt: true, versions: { select: { number: true, signedAt: true, amendmentReason: true }, orderBy: { number: 'asc' } } } },
      },
    });
    if (!a) throw ccError('NOT_FOUND', 404, 'Consultation not found.');
    const audit = await prisma.auditEvent.findMany({ where: { resourceType: { in: ['doctor_appointment', 'appointment'] }, resourceId: a.id }, orderBy: { createdAt: 'asc' } });
    const names = await namesFor(prisma, audit.map((e) => e.actorUserId));
    const events = [
      { at: a.createdAt, kind: 'BOOKING', text: `${a.consultationType === 'VIRTUAL' ? 'Video' : 'In-person'} consultation requested` },
      a.confirmedAt && { at: a.confirmedAt, kind: 'BOOKING', text: 'Doctor confirmed' },
      a.videoRoom && { at: a.videoRoom.createdAt, kind: 'VIDEO', text: 'Video room created' },
      a.videoRoom?.revokedAt && { at: a.videoRoom.revokedAt, kind: 'VIDEO', text: 'Video room closed' },
      a.consultationNote && { at: a.consultationNote.createdAt, kind: 'NOTE', text: 'Consultation note started' },
      ...(a.consultationNote?.versions ?? []).map((v) => ({ at: v.signedAt, kind: 'NOTE', text: v.number === 1 ? 'Consultation note signed' : `Consultation note amended and re-signed (version ${v.number})` })),
      a.completedAt && { at: a.completedAt, kind: 'BOOKING', text: 'Marked completed' },
      a.cancelledAt && { at: a.cancelledAt, kind: 'BOOKING', text: `Cancelled by ${a.cancelledBy?.toLowerCase() ?? 'unknown'}${a.decisionReason ? `: ${a.decisionReason}` : ''}` },
      a.status === 'DECLINED' && { at: a.updatedAt, kind: 'BOOKING', text: `Declined${a.decisionReason ? `: ${a.decisionReason}` : ''}` },
      ...audit.map((e) => ({ at: e.createdAt, kind: e.category === 'ADMIN' ? 'STAFF' : 'ACCESS', text: `${names.get(e.actorUserId) ?? 'Someone'}: ${e.summary}` })),
    ].filter(Boolean).sort((x, y) => x.at - y.at);
    return {
      id: a.id, status: a.status, type: a.consultationType, startsAt: a.startsAt, endsAt: a.endsAt, reasonGiven: Boolean(a.reason),
      patient: { id: a.patient.id, patientId: a.patient.patientId, name: a.patient.full_name },
      doctor: { profileId: a.doctorProfile.id, name: a.doctorProfile.user.full_name, specialty: a.doctorProfile.specialty },
      note: a.consultationNote ? { started: true, signed: Boolean(a.consultationNote.signedVersion), revision: a.consultationNote.revision, lastChangedAt: a.consultationNote.updatedAt } : { started: false, signed: false },
      contentNote: 'Clinical content (the patient’s reason and the note) is not shown here; open the patient’s health information with a stated reason if needed.',
      timeline: events,
    };
  }));

// ------------------------------------------------------------------------------------------------
// Providers: credentials and expiry across doctors, pharmacies and branches
// ------------------------------------------------------------------------------------------------
const expiryState = (at, now) => (!at ? 'UNKNOWN' : at < now ? 'EXPIRED' : at - now <= 30 * DAY ? 'EXPIRING' : 'VALID');

providerRoutes.get('/credentials', allow('platform.ops.read', 'platform.providers.manage'),
  validate(z.object({ query: z.object({ within: z.coerce.number().int().min(1).max(365).default(60), kind: z.enum(['doctor', 'pharmacy', 'branch']).optional() }).strict(), params: none }).passthrough()),
  handle(async (req) => {
    const now = new Date();
    const horizon = new Date(now.getTime() + req.query.within * DAY);
    const want = (k) => !req.query.kind || req.query.kind === k;
    const [pharmacies, branches, doctors] = await Promise.all([
      want('pharmacy') ? prisma.pharmacy.findMany({ where: { complianceStatus: { in: ['VERIFIED', 'SUSPENDED'] }, superintendentLicenceExpiresAt: { lt: horizon } }, select: { id: true, name: true, complianceStatus: true, superintendentLicenceExpiresAt: true } }) : [],
      want('branch') ? prisma.pharmacyBranch.findMany({ where: { status: { in: ['VERIFIED', 'SUSPENDED'] }, licenceExpiresAt: { lt: horizon } }, select: { id: true, name: true, status: true, licenceExpiresAt: true, premisesLicenceNumber: true, pharmacy: { select: { id: true, name: true } } } }) : [],
      // Practising licences live in the application details (annual licences have an expiry date).
      want('doctor') ? prisma.professionalProfile.findMany({ where: { verificationStatus: { in: ['VERIFIED', 'SUSPENDED'] }, doctorApplication: { isNot: null } }, select: { id: true, verificationStatus: true, registrationNumber: true, user: { select: { full_name: true } }, doctorApplication: { select: { details: true } } } }) : [],
    ]);
    const items = [
      ...pharmacies.map((p) => ({ kind: 'pharmacy', id: p.id, name: p.name, credential: 'Superintendent pharmacist licence', providerStatus: p.complianceStatus, expiresAt: p.superintendentLicenceExpiresAt })),
      ...branches.map((b) => ({ kind: 'branch', id: b.id, pharmacyId: b.pharmacy.id, name: `${b.pharmacy.name} — ${b.name}`, credential: `Premises licence ${b.premisesLicenceNumber}`, providerStatus: b.status, expiresAt: b.licenceExpiresAt })),
      ...doctors.flatMap((d) => {
        const details = d.doctorApplication?.details ?? {};
        if (details.licenceType === 'life') return [];
        const at = details.licenceExpiry ? new Date(`${details.licenceExpiry}T23:59:59.999Z`) : null;
        if (at && at >= horizon) return [];
        return [{ kind: 'doctor', id: d.id, name: d.user.full_name, credential: `Practising licence (MDCN ${d.registrationNumber})`, providerStatus: d.verificationStatus, expiresAt: at && Number.isFinite(at.getTime()) ? at : null }];
      }),
    ].map((x) => ({ ...x, state: expiryState(x.expiresAt, now), daysLeft: x.expiresAt ? Math.ceil((x.expiresAt - now) / DAY) : null }))
      .sort((a, b) => (a.expiresAt?.getTime() ?? 0) - (b.expiresAt?.getTime() ?? 0));
    return { within: req.query.within, generatedAt: now.toISOString(), items };
  }));

providerRoutes.get('/summary', allow('platform.ops.read', 'platform.providers.manage'),
  validate(z.object({ query: none, params: none }).passthrough()),
  handle(async () => {
    const [doctors, pharmacies, organisations, riders] = await Promise.all([
      prisma.professionalProfile.groupBy({ by: ['verificationStatus'], _count: { _all: true } }),
      prisma.pharmacy.groupBy({ by: ['complianceStatus'], _count: { _all: true } }),
      prisma.organisation.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.deliveryPartner.groupBy({ by: ['isActive'], _count: { _all: true } }),
    ]);
    const fold = (rows, key) => Object.fromEntries(rows.map((r) => [String(r[key]), r._count._all]));
    return { doctors: fold(doctors, 'verificationStatus'), pharmacies: fold(pharmacies, 'complianceStatus'), organisations: fold(organisations, 'status'), riders: fold(riders, 'isActive') };
  }));

/** Suspend or reinstate a doctor (professional profile), with the reason recorded and audited. */
for (const [action, from, to] of [['suspend', 'VERIFIED', 'SUSPENDED'], ['reinstate', 'SUSPENDED', 'VERIFIED']]) {
  providerRoutes.post(`/doctors/:profileId/${action}`, allow('platform.providers.manage'), requireRecentMfa,
    validate(z.object({ body: z.object({ reason }).strict(), query: none, params: z.object({ profileId: z.string().uuid() }).strict() })),
    handle(async (req) => prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "professional_profiles" WHERE "id" = ${req.params.profileId} FOR UPDATE`;
      const profile = await tx.professionalProfile.findUnique({ where: { id: req.params.profileId }, select: { id: true, userId: true, verificationStatus: true, decisionReason: true, user: { select: { full_name: true } } } });
      if (!profile) throw ccError('NOT_FOUND', 404, 'Doctor not found.');
      if (profile.userId === req.user.id) throw ccError('SAME_PERSON', 403, 'You cannot change your own provider status.');
      if (profile.verificationStatus !== from) throw ccError('INVALID_STATE', 409, `Only a ${from.toLowerCase()} doctor can be ${action === 'suspend' ? 'suspended' : 'reinstated'} (this one is ${profile.verificationStatus.toLowerCase()}).`);
      const updated = await tx.professionalProfile.update({ where: { id: profile.id }, data: { verificationStatus: to, decisionReason: req.body.reason, decidedByUserId: req.user.id, decidedAt: new Date() }, select: { id: true, verificationStatus: true, decidedAt: true } });
      await adminAudit(tx, req, {
        action: 'ADMIN_ACCOUNT_CHANGED', summary: `${action === 'suspend' ? 'Suspended' : 'Reinstated'} doctor ${profile.user.full_name ?? profile.id}`,
        subjectUserId: profile.userId, resourceType: 'professional_profile', resourceId: profile.id, reason: req.body.reason,
        before: { verificationStatus: from }, after: { verificationStatus: to },
      });
      return updated;
    })));
}
