// The portal audit trail: what patients and professionals did, and who touched whose health record.
//
// - recordAudit() writes one append-only entry. Pass the transaction client when the action runs in a
//   transaction, so the entry commits or rolls back with the change it describes.
// - auditFor() lists what one person may see: entries they made, entries about their health record,
//   and entries where they are the other party (e.g. the professional a patient gave access to).
//   Wording is written from the reader's side; IP, device and location are shown only to whoever
//   acted, never to the other people in the entry.
import prisma from '../../config/db.js';
import { currentRequest, maskIp, requestContext } from './audit.context.js';

export const AUDIT_CATEGORIES = ['SIGN_IN', 'RECORD_ACCESS', 'RECORD_CHANGE', 'PERMISSION', 'ACCOUNT', 'ACTIVITY'];

// category + wording per side. {actor} {subject} {related} are names; {other} is whoever is not the reader.
const ACTIONS = {
  SIGNED_IN: ['SIGN_IN', { actor: 'You signed in' }],
  SIGNED_IN_MFA: ['SIGN_IN', { actor: 'You signed in with two-step verification' }],
  SIGN_IN_FAILED: ['SIGN_IN', { actor: 'Someone tried to sign in to your account with a wrong password' }],
  SIGNED_OUT: ['SIGN_IN', { actor: 'You signed out' }],
  SIGNED_OUT_IDLE: ['SIGN_IN', { actor: 'You were signed out after a period of inactivity' }],
  SESSION_REVOKED: ['SIGN_IN', { actor: 'You signed out one of your devices' }],
  SIGNED_OUT_OTHERS: ['SIGN_IN', { actor: 'You signed out all your other devices' }],
  SIGNED_OUT_EVERYWHERE: ['SIGN_IN', { actor: 'You signed out on every device' }],
  PASSWORD_RESET: ['ACCOUNT', { actor: 'Your password was changed' }],

  APPOINTMENT_VIEWED: ['RECORD_ACCESS', { actor: "You opened {subject}'s appointment", subject: '{actor} opened your appointment details' }],
  APPOINTMENT_CONFIRMED: ['RECORD_CHANGE', { actor: "You confirmed {subject}'s appointment", subject: '{actor} confirmed your appointment' }],
  APPOINTMENT_DECLINED: ['RECORD_CHANGE', { actor: "You declined {subject}'s appointment request", subject: '{actor} declined your appointment request' }],
  APPOINTMENT_CANCELLED: ['RECORD_CHANGE', { actor: "You cancelled {subject}'s appointment", subject: '{actor} cancelled your appointment' }],
  APPOINTMENT_COMPLETED: ['RECORD_CHANGE', { actor: "You marked {subject}'s consultation completed", subject: '{actor} marked your consultation completed' }],
  VIDEO_JOINED: ['RECORD_ACCESS', { actor: 'You joined the video consultation with {other}', subject: '{actor} joined your video consultation', related: '{actor} joined the video consultation with you' }],

  CONSULTATION_NOTE_VIEWED: ['RECORD_ACCESS', { actor: "You opened {subject}'s consultation note", subject: '{actor} opened the notes about your consultation' }],
  CONSULTATION_NOTE_SAVED: ['RECORD_CHANGE', { actor: 'You saved consultation notes for {subject}', subject: '{actor} worked on the notes about your consultation' }],
  CONSULTATION_NOTE_SIGNED: ['RECORD_CHANGE', { actor: "You signed {subject}'s consultation note and shared the visit summary", subject: '{actor} signed the notes about your consultation and shared your visit summary' }],

  PRESCRIPTION_VIEWED: ['RECORD_ACCESS', { actor: "You opened {subject}'s prescription", subject: '{actor} opened your prescription' }],
  PRESCRIPTION_DRAFTED: ['RECORD_CHANGE', { actor: 'You drafted a prescription for {subject}', subject: '{actor} started a prescription for you' }],
  PRESCRIPTION_UPDATED: ['RECORD_CHANGE', { actor: 'You edited a prescription draft for {subject}', subject: '{actor} edited a prescription draft for you' }],
  PRESCRIPTION_ISSUED: ['RECORD_CHANGE', { actor: 'You issued a prescription to {subject}', subject: '{actor} issued you a prescription' }],
  PRESCRIPTION_CANCELLED: ['RECORD_CHANGE', { actor: "You cancelled {subject}'s prescription", subject: '{actor} cancelled your prescription' }],

  CARE_PLAN_VIEWED: ['RECORD_ACCESS', { actor: "You opened {subject}'s care plan", subject: '{actor} opened your care plan' }],
  CARE_PLAN_SAVED: ['RECORD_CHANGE', { actor: 'You saved a care plan draft for {subject}', subject: '{actor} worked on your care plan' }],
  CARE_PLAN_PUBLISHED: ['RECORD_CHANGE', { actor: 'You published a care plan to {subject}', subject: '{actor} published a care plan for you' }],
  CARE_PLAN_ARCHIVED: ['RECORD_CHANGE', { actor: "You archived {subject}'s care plan", subject: '{actor} archived your care plan' }],
  CARE_PLAN_NOTE_ADDED: ['RECORD_CHANGE', { actor: "You added a private session note to {subject}'s care plan", subject: '{actor} added a session note to your care plan' }],

  CARE_REQUESTED: ['PERMISSION', { actor: 'You asked {related} to look after your care', related: '{actor} asked you to look after their care' }],
  CARE_ACCEPTED: ['PERMISSION', { actor: "You accepted {subject}'s care request", subject: '{actor} accepted your care request and can now prescribe for you' }],
  CARE_DECLINED: ['PERMISSION', { actor: "You declined {subject}'s care request", subject: '{actor} declined your care request' }],
  CARE_REVOKED: ['PERMISSION', { actor: "You removed {related}'s access to your care", related: '{actor} removed your access to their care' }],
  CARE_PLAN_ACCESS_GRANTED: ['PERMISSION', { actor: 'You allowed {related} to write care plans for you', related: '{actor} allowed you to write care plans for them' }],
  CARE_PLAN_ACCESS_REVOKED: ['PERMISSION', { actor: "You removed {related}'s permission to write care plans for you", related: '{actor} removed your permission to write care plans for them' }],

  WHATSAPP_ENABLED: ['ACCOUNT', { actor: 'You turned on WhatsApp notifications and verified your number' }],
  WHATSAPP_NUMBER_CHANGED: ['ACCOUNT', { actor: 'You changed the number Sabi uses for WhatsApp notifications' }],
  WHATSAPP_DISABLED: ['ACCOUNT', { actor: 'You turned off WhatsApp notifications' }],
  NOTIFICATION_SETTINGS_CHANGED: ['ACCOUNT', { actor: 'You changed your notification settings' }],
  // Medicines: worded per entry (the summary names the medicine and time).
  MEDICATION_SCHEDULE_SAVED: ['ACTIVITY', {}],
  MEDICATION_SCHEDULE_STOPPED: ['ACTIVITY', {}],
  MEDICATION_DOSE_TAKEN: ['ACTIVITY', {}],
  MEDICATION_DOSE_SKIPPED: ['ACTIVITY', {}],
  MEDICATION_REMINDER_SNOOZED: ['ACTIVITY', {}],

  ACTIVITY: ['ACTIVITY', {}],
};

/**
 * Writes one entry. The request (IP, device, location) is taken from the current request scope.
 * `dedupeMinutes` skips a repeat of the same view by the same person within that window, so opening a
 * record ten times in a minute is one entry, not ten.
 */
export async function recordAudit(db, { actorUserId, subjectUserId = null, relatedUserId = null, action, summary, resourceType = null, resourceId = null }, { dedupeMinutes, req = currentRequest() } = {}) {
  const definition = ACTIONS[action];
  if (!definition) throw new Error(`Unknown audit action ${action}`);
  if (req) req.auditRecorded = true;
  if (dedupeMinutes) {
    const recent = await db.auditEvent.findFirst({ where: { actorUserId, subjectUserId, action, resourceId, createdAt: { gte: new Date(Date.now() - dedupeMinutes * 60_000) } }, select: { id: true } });
    if (recent) return null;
  }
  const text = summary || definition[1].actor || action;
  return db.auditEvent.create({ data: {
    actorUserId, subjectUserId, relatedUserId, category: definition[0], action, summary: String(text).slice(0, 300),
    resourceType, resourceId: resourceId ? String(resourceId).slice(0, 64) : null, ...requestContext(req),
  } });
}

const fill = (template, names) => template.replace(/\{(actor|subject|related|other)\}/g, (_, key) => names[key] || 'someone');

/** One page of what this person may see, newest first. `cursor` comes from the previous page. */
export async function auditFor(userId, { limit = 30, cursor, category } = {}, db = prisma) {
  const [cursorAt, cursorId] = cursor ? cursor.split('_') : [];
  const where = {
    AND: [
      { OR: [{ actorUserId: userId }, { subjectUserId: userId }, { relatedUserId: userId }] },
      ...(category ? [{ category }] : []),
      ...(cursorAt ? [{ OR: [{ createdAt: { lt: new Date(cursorAt) } }, { createdAt: new Date(cursorAt), id: { lt: cursorId } }] }] : []),
    ],
  };
  const rows = await db.auditEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
  const page = rows.slice(0, limit);
  const others = [...new Set(page.flatMap((r) => [r.actorUserId, r.subjectUserId, r.relatedUserId]).filter((id) => id && id !== userId))];
  const people = others.length ? await db.user.findMany({ where: { id: { in: others } }, select: { id: true, full_name: true } }) : [];
  const nameOf = new Map(people.map((p) => [p.id, p.full_name || 'A Sabi Health user']));
  return {
    items: page.map((r) => {
      const side = r.actorUserId === userId ? 'actor' : r.subjectUserId === userId ? 'subject' : 'related';
      const names = { actor: nameOf.get(r.actorUserId), subject: nameOf.get(r.subjectUserId), related: nameOf.get(r.relatedUserId) };
      names.other = side === 'actor' ? names.subject || names.related : names.actor;
      const template = ACTIONS[r.action]?.[1]?.[side];
      return {
        id: r.id, at: r.createdAt, category: r.category, action: r.action, side,
        text: template ? fill(template, names) : r.summary,
        ...(side === 'actor' ? { device: r.device, ip: maskIp(r.ipAddress), location: r.city || r.region || r.country ? { city: r.city, region: r.region, country: r.country } : null } : {}),
      };
    }),
    nextCursor: rows.length > limit ? `${page.at(-1).createdAt.toISOString()}_${page.at(-1).id}` : null,
  };
}
