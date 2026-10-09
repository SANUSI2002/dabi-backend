// Extends the profile's existing emergency summary. Medical data is read from its authoritative
// profile and medicine schedules, never copied into a separate emergency record.
import { randomBytes, randomUUID } from 'node:crypto';
import prisma from '../../config/db.js';
import { recordAudit } from '../audit/audit.service.js';
import { notify } from '../notifications/notify.service.js';
import { localDay } from '../medication-schedules/schedule.time.js';

export const EMERGENCY_CONSENT_VERSION = 'emergency-card-v1';
export const DENIED_MESSAGE = 'Emergency information is unavailable or your account is not authorised to access it.';
export const newEmergencyCode = () => `EC-${randomBytes(12).toString('hex').toUpperCase().match(/.{4}/g).join('-')}`;
export const normalizeCode = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const storedCode = (value) => {
  const code = normalizeCode(value);
  return /^EC[0-9A-F]{24}$/.test(code) ? `EC-${code.slice(2).match(/.{4}/g).join('-')}` : null;
};
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const patient = async (db, id) => {
  const who = await db.user.findFirst({ where: { id, accountStatus: 'ACTIVE', roles: { some: { role: 'PATIENT' } } }, select: { id: true, full_name: true } });
  if (!who) fail(403, 'PATIENT_REQUIRED', 'An active patient account is required.');
  return who;
};
const cardFields = {
  userId: true, emergencyCode: true, emergencyCodeVersion: true, emergencyDisplayName: true,
  emergencySharingEnabled: true, emergencyCircleEnabled: true, emergencyHospitalsEnabled: true,
  emergencyConsentVersion: true, emergencyConsentedAt: true,
};
const cardView = (profile, preference, name) => ({
  code: profile.emergencyCode, version: profile.emergencyCodeVersion, displayName: profile.emergencyDisplayName || name || '',
  sharingEnabled: profile.emergencySharingEnabled,
  scopes: { careCircle: profile.emergencyCircleEnabled, hospitals: profile.emergencyHospitalsEnabled },
  notificationEnabled: preference?.emergencyCardEnabled ?? false,
  consent: { version: profile.emergencyConsentVersion, at: profile.emergencyConsentedAt },
});
const transaction = (db, work) => db.$transaction(work, { isolationLevel: 'Serializable', timeout: 15000 });

export function createEmergencyCardService(db = prisma) {
  const getCard = (userId) => transaction(db, async (tx) => {
    const who = await patient(tx, userId);
    let profile = await tx.userProfile.findUnique({ where: { userId }, select: cardFields });
    if (!profile?.emergencyCode) profile = await tx.userProfile.upsert({ where: { userId },
      create: { userId, emergencyCode: newEmergencyCode() }, update: { emergencyCode: newEmergencyCode() }, select: cardFields });
    const pref = await tx.notificationPreference.findUnique({ where: { userId } });
    return cardView(profile, pref, who.full_name);
  });
  const saveCard = (userId, input) => transaction(db, async (tx) => {
    const who = await patient(tx, userId);
    const profile = await tx.userProfile.findUnique({ where: { userId }, select: cardFields });
    if (!profile || profile.emergencyCodeVersion !== input.version) fail(409, 'CARD_CHANGED', 'Your card changed. Refresh and try again.');
    const scopes = input.scopes ?? { careCircle: profile.emergencyCircleEnabled, hospitals: profile.emergencyHospitalsEnabled };
    const enabling = (input.sharingEnabled ?? profile.emergencySharingEnabled) && (!profile.emergencySharingEnabled || scopes.careCircle !== profile.emergencyCircleEnabled || scopes.hospitals !== profile.emergencyHospitalsEnabled);
    if (enabling && input.consentVersion !== EMERGENCY_CONSENT_VERSION) fail(400, 'CONSENT_REQUIRED', 'Please agree to emergency sharing before enabling it or changing its groups.');
    if ((input.sharingEnabled ?? profile.emergencySharingEnabled) && !scopes.careCircle && !scopes.hospitals) fail(400, 'SCOPE_REQUIRED', 'Choose at least one emergency sharing group.');
    const saved = await tx.userProfile.update({ where: { userId }, data: {
      ...(input.displayName !== undefined ? { emergencyDisplayName: input.displayName } : {}),
      ...(input.sharingEnabled !== undefined ? { emergencySharingEnabled: input.sharingEnabled } : {}),
      ...(input.scopes ? { emergencyCircleEnabled: scopes.careCircle, emergencyHospitalsEnabled: scopes.hospitals } : {}),
      ...(enabling ? { emergencyConsentVersion: EMERGENCY_CONSENT_VERSION, emergencyConsentedAt: new Date() } : {}),
    }, select: cardFields });
    const pref = input.notificationEnabled !== undefined
      ? await tx.notificationPreference.upsert({ where: { userId }, create: { userId, emergencyCardEnabled: input.notificationEnabled }, update: { emergencyCardEnabled: input.notificationEnabled } })
      : await tx.notificationPreference.findUnique({ where: { userId } });
    await recordAudit(tx, { actorUserId: userId, action: 'EMERGENCY_CARD_CHANGED', resourceType: 'emergency_card', resourceId: userId,
      context: { sharingEnabled: saved.emergencySharingEnabled, scopes, notificationEnabled: pref?.emergencyCardEnabled ?? false, consentVersion: saved.emergencyConsentVersion } });
    return cardView(saved, pref, who.full_name);
  });
  const replaceCode = (userId, { version }) => transaction(db, async (tx) => {
    const who = await patient(tx, userId);
    const changed = await tx.userProfile.updateMany({ where: { userId, emergencyCodeVersion: version }, data: { emergencyCode: newEmergencyCode(), emergencyCodeVersion: { increment: 1 } } });
    if (!changed.count) fail(409, 'CARD_CHANGED', 'Your card changed. Refresh and try again.');
    await recordAudit(tx, { actorUserId: userId, action: 'EMERGENCY_CODE_REPLACED', resourceType: 'emergency_card', resourceId: userId, context: { previousVersion: version, version: version + 1 } });
    return cardView(await tx.userProfile.findUnique({ where: { userId }, select: cardFields }), await tx.notificationPreference.findUnique({ where: { userId } }), who.full_name);
  });
  const hospitalsFor = async (tx, userId) => {
    const memberships = await tx.organizationMembership.findMany({ where: { userId, status: 'ACTIVE', user: { accountStatus: 'ACTIVE' },
      organization: { type: 'HOSPITAL', organisation: { status: 'VERIFIED', type: 'HOSPITAL', approvedPlatformApplication: { status: 'APPROVED', setupCompletedAt: { not: null } } } },
      roles: { some: { roleCode: { in: ['DOCTOR', 'NURSE'] }, role: { permissions: { some: { permissionCode: 'emergency.summary.read' } } } } },
    }, select: { id: true, organizationId: true, roles: { select: { roleCode: true } }, organization: { select: { organisation: { select: { name: true } } } } } });
    const professional = await tx.professionalProfile.findFirst({ where: { userId, verificationStatus: 'VERIFIED', professionType: { in: ['DOCTOR', 'NURSE'] } }, select: { professionType: true } });
    return memberships.filter((m) => m.roles.some((r) => r.roleCode === professional?.professionType));
  };
  const responderContext = async (userId) => ({ hospitals: (await hospitalsFor(db, userId)).map((m) => ({ id: m.organizationId, name: m.organization.organisation.name })) });
  const lookup = (userId, { code, hospitalId, reason }, req) => transaction(db, async (tx) => {
    const who = await tx.user.findFirst({ where: { id: userId, accountStatus: 'ACTIVE' }, select: { full_name: true } });
    const canonical = storedCode(code);
    const profile = who && canonical ? await tx.userProfile.findUnique({ where: { emergencyCode: canonical } }) : null;
    const target = profile?.emergencySharingEnabled ? await tx.user.findFirst({ where: { id: profile.userId, accountStatus: 'ACTIVE', roles: { some: { role: 'PATIENT' } } }, select: { id: true, patientId: true, full_name: true, dob: true } }) : null;
    let relationship = null; let hospital = null;
    if (target && !hospitalId && profile.emergencyCircleEnabled) {
      relationship = await tx.careRelationship.findFirst({ where: { patientId: target.id, caregiverId: userId, status: 'ACTIVE', revokedAt: null,
        permissions: { has: 'EMERGENCY_SUMMARY' }, emergencyAccessGrantedAt: { not: null }, OR: [{ accessExpiresAt: null }, { accessExpiresAt: { gt: new Date() } }] }, select: { id: true } });
    }
    if (target && hospitalId && profile.emergencyHospitalsEnabled && typeof reason === 'string' && reason.trim().length >= 5 && reason.length <= 300) {
      hospital = (await hospitalsFor(tx, userId)).find((m) => m.organizationId === hospitalId);
    }
    if (!target || (!relationship && !hospital)) {
      await recordAudit(tx, { actorUserId: userId, action: 'EMERGENCY_ACCESS_DENIED', context: { outcome: 'DENIED', mode: hospitalId ? 'HOSPITAL' : 'CARE_CIRCLE', requestedHospitalId: hospitalId || null, reason: hospitalId && typeof reason === 'string' ? reason.trim().slice(0, 300) : null } }, { req });
      return { denied: true }; // Commit the denial audit; never throw inside its transaction.
    }
    const id = randomUUID(); const now = new Date();
    const summary = await emergencySummary(tx, target, profile, now);
    const mode = hospital ? 'HOSPITAL' : 'CARE_CIRCLE';
    await recordAudit(tx, { actorUserId: userId, subjectUserId: target.id, action: 'EMERGENCY_SUMMARY_ACCESSED', resourceType: 'emergency_access', resourceId: id,
      context: { outcome: 'SUCCESS', mode, hospitalId: hospital?.organizationId ?? null, membershipId: hospital?.id ?? null, relationshipId: relationship?.id ?? null, reason: hospital ? reason.trim() : null, codeVersion: profile.emergencyCodeVersion } }, { req });
    await notify(tx, { userId: target.id, eventType: 'emergency.accessed', eventKey: `emergency.accessed:${id}`, title: 'Your emergency summary was accessed',
      message: `${who.full_name || 'An authorised Sabi user'}${hospital ? ` at ${hospital.organization.organisation.name}` : ' in your Care Circle'} accessed your emergency summary at ${now.toISOString()}.`, link: '/activity' });
    return { summary, access: { mode, at: now.toISOString(), hospital: hospital?.organization.organisation.name ?? null } };
  });
  return { getCard, saveCard, replaceCode, lookup, responderContext };
}

const strings = (value) => String(value || '').split(/[;\n]/).map((v) => v.trim()).filter(Boolean).slice(0, 50);
const reported = (value, at) => ({ value: value || null, source: value ? 'Patient profile' : null, verification: value ? 'PATIENT_REPORTED' : 'UNKNOWN', updatedAt: at });
// Do not invent duration or infer that an old prescription is still current. Only active, dated
// schedules are current medicines; attach the issued prescription's recorded instructions if linked.
export async function emergencySummary(db, who, profile, now = new Date()) {
  const firstDay = new Date(now); firstDay.setUTCHours(0, 0, 0, 0); firstDay.setUTCDate(firstDay.getUTCDate() - 1);
  const lastDay = new Date(now); lastDay.setUTCHours(0, 0, 0, 0); lastDay.setUTCDate(lastDay.getUTCDate() + 1);
  const schedules = await db.medicationSchedule.findMany({ where: { userId: who.id, status: { in: ['ACTIVE', 'PAUSED'] }, startDate: { lte: lastDay }, OR: [{ endDate: null }, { endDate: { gte: firstDay } }] },
    select: { id: true, name: true, dosage: true, instructions: true, source: true, prescriptionItemId: true, updatedAt: true, status: true, timezone: true, startDate: true, endDate: true }, orderBy: { updatedAt: 'desc' }, take: 50 });
  const medications = []; const dates = [profile.updated_at];
  for (const m of schedules) {
    const day = new Date(`${localDay(now, m.timezone)}T00:00:00Z`);
    if ((m.startDate && m.startDate > day) || (m.endDate && m.endDate < day)) continue;
    const item = m.prescriptionItemId ? await db.prescriptionItem.findFirst({ where: { id: m.prescriptionItemId, prescription: { patientId: who.id, status: 'ISSUED' } }, select: {
      medicationName: true, dosage: true, frequency: true, route: true, duration: true, prescription: { select: { instructions: true, issuedAt: true, issuerAttestedAt: true } },
    } }) : null;
    if (m.prescriptionItemId && !item) continue;
    medications.push({ name: item?.medicationName || m.name, dosage: item?.dosage || m.dosage, instructions: item ? [item.frequency, item.route, item.duration, item.prescription.instructions].filter(Boolean).join(' · ') : m.instructions,
      status: m.status, source: item ? 'Issued prescription' : 'My Medicines', verification: item ? 'CLINICIAN_RECORDED' : 'PATIENT_REPORTED', updatedAt: item?.prescription.issuedAt || m.updatedAt });
    dates.push(m.updatedAt, item?.prescription.issuedAt);
  }
  const recordedNegative = /^(?:no known allergies|no known drug allergies|nka|nkda)[.!]?$/i.test(String(profile.known_allergies || '').trim());
  return {
    identification: { name: who.full_name, displayName: profile.emergencyDisplayName || who.full_name, patientReference: who.patientId, dateOfBirth: who.dob },
    allergies: { state: recordedNegative ? 'NO_KNOWN_RECORDED' : profile.known_allergies?.trim() ? 'RECORDED' : 'UNKNOWN',
      items: recordedNegative ? [] : strings(profile.known_allergies).map((value) => ({ ...reported(value, profile.updated_at), reaction: null })), verification: profile.known_allergies?.trim() ? 'PATIENT_REPORTED' : 'UNKNOWN' },
    medications: { items: medications, patientReported: strings(profile.current_medications).map((value) => reported(value, profile.updated_at)), state: medications.length || profile.current_medications?.trim() ? 'RECORDED' : 'UNKNOWN' },
    conditions: { items: strings(profile.chronic_conditions).map((value) => reported(value, profile.updated_at)), state: profile.chronic_conditions?.trim() ? 'RECORDED' : 'UNKNOWN' },
    bloodGroup: reported(profile.blood_type, profile.updated_at),
    contacts: profile.emergencyContactName || profile.emergencyContactPhone ? [{ name: profile.emergencyContactName || null, phone: profile.emergencyContactPhone || null, relationship: profile.emergencyContactRelation || null, verification: 'PATIENT_REPORTED' }] : [],
    lastUpdatedAt: dates.filter(Boolean).length ? new Date(Math.max(...dates.filter(Boolean).map((date) => new Date(date).getTime()))).toISOString() : null,
    notice: 'Read-only emergency information. Recorded blood group is not a substitute for clinical testing. Unknown means no information has been recorded, not a negative clinical finding.',
  };
}

export const emergencyCardService = createEmergencyCardService();
