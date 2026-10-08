// Records every change a signed-in person makes through the API that no specific audit entry already
// describes (booking, profile edits, vitals, documents, orders…), so the Activity log misses nothing.
// Reads are not recorded here; access to someone else's health record is recorded where it happens.
import prisma from '../../config/db.js';
import { recordAudit } from './audit.service.js';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Session plumbing, video access checks and modules with their own audit trail.
const SKIP = [/^\/api\/v1\/auth\//, /\/video-session$/, /^\/api\/v1\/emr\//, /^\/api\/v1\/platform\//, /^\/api\/v1\/internal\//, /^\/api\/v1\/audit\//];
// Path parts that identify a record (uuids, numbers, references such as SABI-T-1a2b3c) rather than name an area.
const ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|(?=[A-Z0-9-]*\d)[A-Z0-9-]{8,})$/i;

// Plain names for API areas; anything missing falls back to its path words.
const AREAS = {
  'doctor-appointments': 'a doctor appointment', 'hospital-appointments': 'a hospital appointment', appointments: 'an appointment',
  'hospital-enrollments': 'a hospital enrolment', wellness: 'a wellness booking', 'medical-documents': 'a medical document',
  'medical-records': 'your medical record', profile: 'your profile', vitals: 'vitals', 'health-metrics': 'a health reading',
  medications: 'a medication', 'family-care': 'your family care circle', notifications: 'a notification',
  'professional-schedule': 'your schedule', 'professional-care': 'a care plan', prescriptions: 'a prescription',
  'pharmacy-requests': 'a pharmacy request', reservations: 'a medicine reservation', orders: 'an order', delivery: 'a delivery',
  'doctor-care': 'a care relationship', 'consultation-notes': 'a consultation note', doctors: 'your professional application',
  professionals: 'your professional profile', organisations: 'an organisation', hospitals: 'a hospital plan', inventory: 'pharmacy stock',
};
// Final path words that name the action itself (…/:id/cancel).
const VERBS = {
  cancel: 'cancelled', reschedule: 'rescheduled', confirm: 'confirmed', decline: 'declined', complete: 'completed', accept: 'accepted',
  revoke: 'revoked', approve: 'approved', reject: 'rejected', publish: 'published', archive: 'archived', sign: 'signed', issue: 'issued',
  read: 'marked as read', 'read-all': 'marked all as read', share: 'shared', submit: 'submitted', respond: 'responded to', join: 'joined',
  'check-in': 'checked in to', pay: 'paid for', feedback: 'sent feedback on',
};
// Hand-written wording for common actions, keyed by method and path with ids as :id.
const EXACT = {
  'POST doctor-appointments': 'You requested a doctor appointment',
  'POST doctor-appointments/:id/reschedule': 'You asked to reschedule a doctor appointment',
  'POST professional-schedule/blocks': 'You blocked time off in your schedule',
  'DELETE professional-schedule/blocks/:id': 'You removed time off from your schedule',
  'POST professional-schedule/publish': 'You published available slots',
  'POST professional-schedule/exceptions': 'You published extra hours on one date',
  'PATCH notifications/:id/read': 'You marked a notification as read',
  'PATCH notifications/read-all': 'You marked all notifications as read',
  'POST medical-documents/uploads': 'You uploaded a medical document',
  'POST family-care/invitations/accept': 'You accepted a family care circle invitation',
  'POST hospital-enrollments': 'You applied to enrol with a hospital',
  'POST vitals': 'You recorded your vitals',
};
const DEFAULT_VERB ={ POST: 'added', PUT: 'updated', PATCH: 'updated', DELETE: 'removed' };

/** "You cancelled a doctor appointment" from "POST /api/v1/doctor-appointments/<id>/cancel". */
export function activityLabel(method, path) {
  const parts = path.replace(/^\/api\/v1\//, '').split('/').filter(Boolean);
  const exact = EXACT[`${method} ${parts.map((part) => (ID.test(part) ? ':id' : part)).join('/')}`];
  if (exact) return exact;
  const area = AREAS[parts[0]] || parts[0]?.replace(/-/g, ' ') || 'your account';
  const words = parts.slice(1).filter((part) => !ID.test(part));
  const last = words.at(-1);
  const verb = VERBS[last] || DEFAULT_VERB[method] || 'changed';
  const detail = words.filter((word) => word !== last || !VERBS[last]).map((word) => word.replace(/-/g, ' '));
  const subject = detail.length && !VERBS[last] ? `${detail.join(' ')} in ${area}` : area;
  return `You ${verb} ${subject}`.slice(0, 300);
}

export const auditActivity = (req, res, next) => {
  if (!WRITES.has(req.method)) return next();
  res.on('finish', () => {
    const path = req.originalUrl.split('?')[0];
    if (!req.user?.id || res.statusCode >= 400 || req.auditRecorded || SKIP.some((rule) => rule.test(path))) return;
    // After the response: a failure here cannot undo the change, so it is reported, not thrown.
    recordAudit(prisma, { actorUserId: req.user.id, action: 'ACTIVITY', summary: activityLabel(req.method, path) }, { req })
      .catch((error) => console.error('[audit] activity entry not written:', error.message));
  });
  return next();
};
