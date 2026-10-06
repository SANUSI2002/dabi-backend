import crypto from 'node:crypto';
import { setInterval, clearInterval } from 'node:timers';
import prisma from '../../config/db.js';
import { PORTAL_PROFESSIONS } from '../professionals/professionCatalog.js';
import { createDailyProvider, dailyConfigured, videoError } from './daily.provider.js';
const MINUTE = 60000;
const select = { id: true, patientId: true, startsAt: true, endsAt: true, status: true, consultationType: true,
  patient: { select: { accountStatus: true, emailVerifiedAt: true } },
  doctorProfile: { select: { userId: true, professionType: true, verificationStatus: true, user: { select: { accountStatus: true, emailVerifiedAt: true } } } } };
export function createVideoService({ db = prisma, provider = createDailyProvider(), env = process.env, now = () => new Date() } = {}) {
  async function authorize(userId, id, role) {
    const row = await db.doctorAppointment.findFirst({ where: { id, ...(role === 'doctor' ? { doctorProfile: { userId } } : { patientId: userId }) }, select });
    if (!row) throw videoError('VIDEO_NOT_FOUND', 404);
    const doctor = row.doctorProfile;
    if (!PORTAL_PROFESSIONS.includes(doctor.professionType) || doctor.verificationStatus !== 'VERIFIED'
      || doctor.user.accountStatus !== 'ACTIVE' || !doctor.user.emailVerifiedAt
      || row.patient.accountStatus !== 'ACTIVE' || !row.patient.emailVerifiedAt) throw videoError('VIDEO_ACCESS_DENIED', 403);
    if (role === 'patient' && !(await db.userRole.findFirst({ where: { userId, role: 'PATIENT' }, select: { id: true } }))) throw videoError('VIDEO_ACCESS_DENIED', 403);
    if (row.status !== 'CONFIRMED' || row.consultationType !== 'VIRTUAL') throw videoError('VIDEO_APPOINTMENT_NOT_READY', 409);
    const time = now().getTime();
    if (time < new Date(row.startsAt).getTime() - 10 * MINUTE) throw videoError('VIDEO_TOO_EARLY', 409);
    if (time >= new Date(row.endsAt).getTime() + 15 * MINUTE) throw videoError('VIDEO_WINDOW_ENDED', 409);
    return row;
  }
  // The doctor and the patient often press "Join" together. An upsert is a read then an insert, so
  // both can take the insert branch and one fails on the unique appointmentId. Insert with
  // ON CONFLICT DO NOTHING instead, then read back whichever row won: both joiners share one room.
  async function roomFor(appointment) {
    const existing = await db.doctorVideoRoom.findUnique({ where: { appointmentId: appointment.id } });
    if (existing) return existing;
    await db.doctorVideoRoom.createMany({ data: [{ appointmentId: appointment.id, roomName: `sabi-v-${crypto.randomBytes(16).toString('hex')}`, expiresAt: new Date(new Date(appointment.endsAt).getTime() + 15 * MINUTE) }], skipDuplicates: true });
    const room = await db.doctorVideoRoom.findUnique({ where: { appointmentId: appointment.id } });
    if (!room) throw videoError('VIDEO_UNAVAILABLE');
    return room;
  }
  return {
    config: () => ({ enabled: dailyConfigured(env), joinMinutesBefore: 10, graceMinutesAfter: 15 }),
    check: async (userId, id, role) => {
      await authorize(userId, id, role);
      if (!dailyConfigured(env)) throw videoError('VIDEO_UNAVAILABLE');
      const room = await db.doctorVideoRoom.findUnique({ where: { appointmentId: id } });
      if (room?.revokedAt) throw videoError('VIDEO_WINDOW_ENDED', 409);
      return { eligible: true };
    },
    join: async (userId, id, role, consent) => {
      const appointment = await authorize(userId, id, role);
      if (!dailyConfigured(env)) throw videoError('VIDEO_UNAVAILABLE');
      if (!consent.providerConsent) throw videoError('VIDEO_CONSENT_REQUIRED', 400);
      const room = await roomFor(appointment);
      if (room.revokedAt || new Date(room.expiresAt) <= now()) throw videoError('VIDEO_WINDOW_ENDED', 409);
      const remote = await provider.ensureRoom(room, appointment.startsAt);
      await authorize(userId, id, role);
      const token = await provider.token(room, role);
      await authorize(userId, id, role);
      const latest = await db.doctorVideoRoom.findUnique({ where: { appointmentId: id } });
      if (latest?.revokedAt) throw videoError('VIDEO_WINDOW_ENDED', 409);
      await db.activityLog.create({ data: { userId, type: 'DOCTOR_VIDEO_JOIN_AUTHORIZED', description: 'Private consultation access issued', meta: { appointmentId: id, role, consentVersion: 'daily-video-v1' } } });
      return { url: remote.url, token, expiresAt: room.expiresAt };
    },
    cleanup: async () => {
      if (!env.DAILY_API_KEY) return;
      const time = now();
      const rows = await db.doctorVideoRoom.findMany({ where: { revokedAt: null, cleanupAfter: { lte: time }, OR: [
        { expiresAt: { lte: time } }, { appointment: { status: { not: 'CONFIRMED' } } },
        { appointment: { doctorProfile: { verificationStatus: { not: 'VERIFIED' } } } },
        { appointment: { doctorProfile: { professionType: { notIn: PORTAL_PROFESSIONS } } } },
        { appointment: { doctorProfile: { user: { accountStatus: { not: 'ACTIVE' } } } } },
        { appointment: { doctorProfile: { user: { emailVerifiedAt: null } } } },
        { appointment: { patient: { accountStatus: { not: 'ACTIVE' } } } },
        { appointment: { patient: { emailVerifiedAt: null } } },
      ] }, take: 20, orderBy: { cleanupAfter: 'asc' } });
      for (const row of rows) {
        try { await provider.revoke(row); await db.doctorVideoRoom.updateMany({ where: { appointmentId: row.appointmentId, revokedAt: null }, data: { revokedAt: now() } }); }
        catch { await db.doctorVideoRoom.updateMany({ where: { appointmentId: row.appointmentId, revokedAt: null }, data: { cleanupAfter: new Date(now().getTime() + MINUTE) } }); }
      }
    },
  };
}
export const videoService = createVideoService();
export function startVideoCleanup() {
  let running = false;
  const tick = async () => { if (running) return; running = true; try { await videoService.cleanup(); } catch { console.error('[video] cleanup will retry'); } finally { running = false; } };
  const timer = setInterval(tick, 15000); timer.unref?.();
  return () => clearInterval(timer);
}
