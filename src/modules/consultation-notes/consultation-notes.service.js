// Consultation notes: the doctor's record of a telemedicine consultation and the visit summary the
// patient receives.
//
// Invariants
// - Only the verified DOCTOR who owns the appointment can read or write its note.
// - A note can be drafted for a CONFIRMED or COMPLETED appointment, and signed only once the
//   appointment is COMPLETED.
// - Every write checks the note's revision (optimistic concurrency) under a row lock in a
//   serializable transaction, so two tabs cannot silently overwrite each other.
// - Signing appends an immutable version (the table is append-only in SQL). Signing again is an
//   amendment: it needs a reason and an actual change.
// - Patients see only the visit summary of signed versions; never drafts, clinical sections or
//   amendment reasons. Audit entries and notifications carry identifiers, never clinical text.
import { isDeepStrictEqual } from 'node:util';
import prisma from '../../config/db.js';
import { contentSchema, patientVisitSummary, signingProblems } from './consultation-notes.policy.js';

const fail = (status, code, message, extra = {}) => { throw Object.assign(new Error(message), { status, code, ...extra }); };
const DRAFTABLE = ['CONFIRMED', 'COMPLETED'];
// What the patient projection (patientVisitSummary) reads. Amendment reasons are deliberately absent.
const patientSelect = {
  appointmentId: true, signedVersion: true,
  versions: { orderBy: { number: 'desc' }, select: { number: true, content: true, signedAt: true } },
  appointment: { select: { startsAt: true, consultationType: true, dependent: { select: { fullName: true } } } },
  doctorProfile: { select: { specialty: true, user: { select: { full_name: true } } } },
};
const STALE = 'This note changed in another tab or device. Refresh before editing.';

const appointmentSelect = {
  id: true, patientId: true, dependentId: true, startsAt: true, endsAt: true, consultationType: true, reason: true, status: true, completedAt: true,
  patient: { select: { full_name: true, patientId: true } },
  dependent: { select: { fullName: true, dateOfBirth: true } },
};
// The doctor sees the patient's name and Sabi patient ID, not their internal account id.
const toAppointment = (a) => ({
  id: a.id, dependentId: a.dependentId, startsAt: a.startsAt, endsAt: a.endsAt, consultationType: a.consultationType,
  reason: a.reason, status: a.status, completedAt: a.completedAt,
  patient: { name: a.patient?.full_name ?? null, patientId: a.patient?.patientId ?? null },
  dependent: a.dependent ? { name: a.dependent.fullName, dateOfBirth: a.dependent.dateOfBirth } : null,
});
// True when the draft was edited after the latest signature (the patient still sees the signed text).
const hasUnsignedChanges = (signedVersion, draft, latest) => Boolean(signedVersion) && !isDeepStrictEqual(contentSchema.parse(draft), contentSchema.parse(latest.content));
const toDoctorNote = (note) => note && ({
  id: note.id,
  revision: note.revision,
  signedVersion: note.signedVersion,
  draft: contentSchema.parse(note.draft),
  updatedAt: note.updatedAt,
  hasUnsignedChanges: hasUnsignedChanges(note.signedVersion, note.draft, note.versions[0]),
  versions: note.versions.map((v) => ({ number: v.number, signedAt: v.signedAt, amendmentReason: v.amendmentReason })),
});

export function createConsultationNotesService(db = prisma) {
  const transaction = (work) => db.$transaction(work, { isolationLevel: 'Serializable', timeout: 30000 });
  const audit = (tx, userId, type, appointmentId) => tx.activityLog.create({ data: { userId, type, description: 'Consultation note action', meta: { appointmentId } } });

  async function doctor(tx, userId) {
    const profile = await tx.professionalProfile.findFirst({
      where: { userId, professionType: 'DOCTOR', verificationStatus: 'VERIFIED' },
      select: { id: true, user: { select: { full_name: true } } },
    });
    if (!profile) fail(403, 'FORBIDDEN', 'Consultation notes need a verified doctor account.');
    return profile;
  }
  async function ownedAppointment(tx, doctorId, appointmentId) {
    const appointment = await tx.doctorAppointment.findFirst({ where: { id: appointmentId, doctorProfileId: doctorId }, select: appointmentSelect });
    if (!appointment) fail(404, 'NOT_FOUND', 'Appointment not found.');
    return appointment;
  }
  const lockNote = (tx, appointmentId) => tx.$queryRaw`SELECT id FROM consultation_notes WHERE appointment_id = ${appointmentId} FOR UPDATE`;
  const noteFor = (tx, appointmentId) => tx.consultationNote.findUnique({ where: { appointmentId }, include: { versions: { orderBy: { number: 'desc' } } } });

  /** This doctor's earlier signed notes for the same patient (and the same dependant, if any). */
  async function previousNotes(tx, doctorId, appointment) {
    const notes = await tx.consultationNote.findMany({
      where: { doctorProfileId: doctorId, patientId: appointment.patientId, appointmentId: { not: appointment.id }, signedVersion: { not: null }, appointment: { dependentId: appointment.dependentId } },
      select: { appointmentId: true, appointment: { select: { startsAt: true } }, versions: { orderBy: { number: 'desc' }, take: 1, select: { content: true, signedAt: true } } },
      orderBy: { appointment: { startsAt: 'desc' } },
      take: 5,
    });
    return notes.map(({ appointmentId, appointment: a, versions: [latest] }) => {
      const { clinical } = contentSchema.parse(latest.content);
      return { appointmentId, startsAt: a.startsAt, signedAt: latest.signedAt, assessment: clinical.assessment, plan: clinical.plan };
    });
  }

  async function detailView(tx, doctorId, appointment) {
    const [note, previous] = await Promise.all([noteFor(tx, appointment.id), previousNotes(tx, doctorId, appointment)]);
    return { appointment: toAppointment(appointment), note: toDoctorNote(note), canSign: appointment.status === 'COMPLETED', previous };
  }

  return {
    practiceList: async (userId, { limit, offset }) => {
      const { id: doctorId } = await doctor(db, userId);
      const listSelect = { startsAt: true, consultationType: true, status: true, patient: { select: { full_name: true, patientId: true } }, dependent: { select: { fullName: true } } };
      const [notes, total, awaiting] = await Promise.all([
        db.consultationNote.findMany({
          where: { doctorProfileId: doctorId },
          select: { appointmentId: true, revision: true, signedVersion: true, draft: true, updatedAt: true, appointment: { select: listSelect }, versions: { orderBy: { number: 'desc' }, take: 1, select: { content: true } } },
          orderBy: { updatedAt: 'desc' }, take: limit, skip: offset,
        }),
        db.consultationNote.count({ where: { doctorProfileId: doctorId } }),
        // Completed consultations still waiting for a signed note.
        db.doctorAppointment.findMany({
          where: { doctorProfileId: doctorId, status: 'COMPLETED', OR: [{ consultationNote: { is: null } }, { consultationNote: { is: { signedVersion: null } } }] },
          select: { id: true, ...listSelect }, orderBy: { startsAt: 'desc' }, take: 20,
        }),
      ]);
      const who = (a) => ({ patient: { name: a.patient?.full_name ?? null, patientId: a.patient?.patientId ?? null }, forName: a.dependent?.fullName ?? null });
      return {
        items: notes.map((n) => ({
          appointmentId: n.appointmentId, startsAt: n.appointment.startsAt, consultationType: n.appointment.consultationType, appointmentStatus: n.appointment.status,
          ...who(n.appointment), signedVersion: n.signedVersion, updatedAt: n.updatedAt,
          hasUnsignedChanges: hasUnsignedChanges(n.signedVersion, n.draft, n.versions[0]),
        })),
        total, limit, offset,
        awaiting: awaiting.map((a) => ({ appointmentId: a.id, startsAt: a.startsAt, consultationType: a.consultationType, ...who(a) })),
      };
    },

    detail: async (userId, appointmentId) => {
      const { id: doctorId } = await doctor(db, userId);
      return detailView(db, doctorId, await ownedAppointment(db, doctorId, appointmentId));
    },

    save: (userId, appointmentId, { revision, content }) => transaction(async (tx) => {
      const { id: doctorId } = await doctor(tx, userId);
      const appointment = await ownedAppointment(tx, doctorId, appointmentId);
      if (!DRAFTABLE.includes(appointment.status)) fail(409, 'INVALID_STATE', 'Notes can be written for confirmed or completed consultations only.');
      const draft = contentSchema.parse(content);
      await lockNote(tx, appointmentId);
      const existing = await tx.consultationNote.findUnique({ where: { appointmentId }, select: { id: true, revision: true } });
      if (existing) {
        if (revision !== existing.revision) fail(409, 'STALE', STALE);
        await tx.consultationNote.update({ where: { id: existing.id }, data: { draft, revision: { increment: 1 } } });
      } else {
        if (revision !== undefined) fail(409, 'STALE', STALE);
        await tx.consultationNote.create({ data: { appointmentId, doctorProfileId: doctorId, patientId: appointment.patientId, draft } });
      }
      await audit(tx, userId, 'CONSULTATION_NOTE_DRAFT_SAVED', appointmentId);
      return detailView(tx, doctorId, appointment);
    }),

    sign: (userId, appointmentId, { revision, amendmentReason }) => transaction(async (tx) => {
      const profile = await doctor(tx, userId);
      const appointment = await ownedAppointment(tx, profile.id, appointmentId);
      if (appointment.status !== 'COMPLETED') fail(409, 'NOT_COMPLETED', 'Mark the consultation completed before signing the note.');
      await lockNote(tx, appointmentId);
      const note = await noteFor(tx, appointmentId);
      if (!note) fail(404, 'NOT_FOUND', 'Save the note before signing it.');
      if (note.revision !== revision) fail(409, 'STALE', STALE);
      const content = contentSchema.parse(note.draft);
      const problems = signingProblems(content);
      if (problems.length) fail(400, 'INCOMPLETE', problems.join(' '), { problems });
      const latest = note.versions[0];
      if (latest) {
        if (!amendmentReason) fail(400, 'AMENDMENT_REASON_REQUIRED', 'Give a reason for changing a signed note.');
        if (isDeepStrictEqual(contentSchema.parse(latest.content), content)) fail(409, 'NO_CHANGES', 'Nothing has changed since the signed version.');
      }
      const number = (latest?.number ?? 0) + 1;
      await tx.consultationNoteVersion.create({ data: { noteId: note.id, number, content, amendmentReason: latest ? amendmentReason : null } });
      await tx.consultationNote.update({ where: { id: note.id }, data: { draft: content, signedVersion: number, revision: { increment: 1 } } });
      const doctorName = profile.user?.full_name || 'Your doctor';
      await tx.notification.create({
        data: latest
          ? { userId: appointment.patientId, title: 'Your visit summary was updated', message: `${doctorName} updated the summary of your consultation. Open Appointments in Sabi Health to read it.` }
          : { userId: appointment.patientId, title: 'Your visit summary is ready', message: `${doctorName} shared the summary of your consultation. Open Appointments in Sabi Health to read it.` },
      });
      await audit(tx, userId, latest ? 'CONSULTATION_NOTE_AMENDED' : 'CONSULTATION_NOTE_SIGNED', appointmentId);
      return detailView(tx, profile.id, appointment);
    }),

    patientList: async (userId) => {
      const notes = await db.consultationNote.findMany({
        where: { patientId: userId, signedVersion: { not: null } },
        select: patientSelect,
        orderBy: { appointment: { startsAt: 'desc' } },
        take: 100,
      });
      return notes.map(patientVisitSummary).filter(Boolean);
    },

    patientOne: async (userId, appointmentId) => {
      const note = await db.consultationNote.findFirst({
        where: { appointmentId, patientId: userId, signedVersion: { not: null } },
        select: patientSelect,
      });
      const summary = note && patientVisitSummary(note);
      if (!summary) fail(404, 'NOT_FOUND', 'No visit summary has been shared for this consultation yet.');
      return summary;
    },
  };
}

export const consultationNotesService = createConsultationNotesService();
