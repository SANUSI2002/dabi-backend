// Consultation notes on a real database: access rules, the draft → sign → amend lifecycle, what
// patients can see, and the constraints Postgres enforces on its own (append-only versions,
// note parties matching the appointment). All data is synthetic.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { prisma, tokenFor } from './fixtures.js';

const BASE = '/api/v1/consultation-notes';
const tag = () => randomUUID().slice(0, 8);

async function account(label, professionType) {
  const t = tag();
  const user = await prisma.user.create({ data: { patientId: `SABI-CN-${t}`, email: `${label}-${t}@notes.test`, password: 'not-a-real-hash', full_name: `${label} ${t}`, accountStatus: 'ACTIVE', emailVerifiedAt: new Date() } });
  const profile = professionType
    ? await prisma.professionalProfile.create({ data: { userId: user.id, professionType, registrationNumber: `REG-${t}`, verificationStatus: 'VERIFIED' } })
    : null;
  return { id: user.id, name: user.full_name, profileId: profile?.id, auth: tokenFor(user.id) };
}

/** An appointment in the given state; past ones started 40 minutes ago. */
async function appointment(doctor, patient, { status = 'CONFIRMED', past = true, dependentId } = {}) {
  const startsAt = new Date(Date.now() + (past ? -40 : 60 * 24) * 60_000);
  const endsAt = new Date(startsAt.getTime() + 20 * 60_000);
  const slot = await prisma.doctorAvailabilitySlot.create({ data: { doctorProfileId: doctor.profileId, startsAt, endsAt, consultationTypes: ['VIRTUAL'] } });
  return prisma.doctorAppointment.create({
    data: { patientId: patient.id, dependentId, doctorProfileId: doctor.profileId, slotId: slot.id, startsAt, endsAt, consultationType: 'VIRTUAL', reason: 'Synthetic reason', status, ...(status === 'COMPLETED' ? { completedAt: new Date() } : {}) },
  });
}

const complete = (doctor, id) => request(app).post(`/api/v1/doctor-appointments/practice/appointments/${id}/complete`).set('Authorization', doctor.auth).send({});
const save = (who, id, body) => request(app).put(`${BASE}/practice/appointments/${id}`).set('Authorization', who.auth).send(body);
const sign = (who, id, body) => request(app).post(`${BASE}/practice/appointments/${id}/sign`).set('Authorization', who.auth).send(body);
const detail = (who, id) => request(app).get(`${BASE}/practice/appointments/${id}`).set('Authorization', who.auth);

const PRIVATE = 'PRIVATE-CLINICAL-TEXT';
const full = (overrides = {}) => ({
  clinical: { presentingComplaint: `${PRIVATE} complaint`, history: `${PRIVATE} history`, findings: `${PRIVATE} findings`, assessment: `${PRIVATE} assessment`, plan: `${PRIVATE} plan` },
  patient: { summary: 'We discussed your symptoms.', advice: 'Rest and drink water.', warningSigns: 'Seek care if it worsens.', followUp: { needed: true, timeframe: 'In two weeks', instructions: 'Book a video follow-up.' } },
  ...overrides,
});

let doctor; let otherDoctor; let counsellor; let patient;
beforeAll(async () => {
  [doctor, otherDoctor, counsellor, patient] = await Promise.all([account('doctor', 'DOCTOR'), account('other-doctor', 'DOCTOR'), account('counsellor', 'COUNSELLOR'), account('patient')]);
});

describe('who can read and write a consultation note', () => {
  it('only the verified doctor who owns the appointment', async () => {
    const appt = await appointment(doctor, patient);
    expect((await save(doctor, appt.id, { content: full() })).status).toBe(200);
    // Another doctor cannot tell the appointment exists; other roles are refused outright.
    expect((await detail(otherDoctor, appt.id)).status).toBe(404);
    expect((await save(otherDoctor, appt.id, { content: full() })).status).toBe(404);
    expect((await detail(counsellor, appt.id)).status).toBe(403);
    expect((await detail(patient, appt.id)).status).toBe(403);
    expect((await request(app).get(`${BASE}/practice`).set('Authorization', patient.auth)).status).toBe(403);
  });

  it('only for confirmed or completed consultations', async () => {
    for (const status of ['REQUESTED', 'CANCELLED', 'DECLINED']) {
      const appt = await appointment(doctor, patient, { status, past: false });
      const res = await save(doctor, appt.id, { content: full() });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_STATE');
    }
  });
});

describe('draft → sign → amend', () => {
  it('keeps drafts private, signs only completed consultations, and shares just the visit summary', async () => {
    const appt = await appointment(doctor, patient);
    const draft = await save(doctor, appt.id, { content: { clinical: { assessment: `${PRIVATE} early` } } });
    expect(draft.status).toBe(200);
    expect(draft.body.data.note).toMatchObject({ revision: 1, signedVersion: null });
    expect(draft.body.data.canSign).toBe(false);

    // Drafts never reach the patient.
    expect((await request(app).get(`${BASE}/mine/${appt.id}`).set('Authorization', patient.auth)).status).toBe(404);

    const early = await sign(doctor, appt.id, { revision: 1 });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('NOT_COMPLETED');

    expect((await complete(doctor, appt.id)).status).toBe(200);
    const incomplete = await sign(doctor, appt.id, { revision: 1 });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.code).toBe('INCOMPLETE');
    expect(incomplete.body.problems).toEqual(expect.arrayContaining(['Add the plan.', 'Write the visit summary for the patient.']));

    const saved = await save(doctor, appt.id, { revision: 1, content: full() });
    expect(saved.body.data.note.revision).toBe(2);
    const signed = await sign(doctor, appt.id, { revision: 2 });
    expect(signed.status).toBe(200);
    expect(signed.body.data.note).toMatchObject({ signedVersion: 1, revision: 3, hasUnsignedChanges: false });

    const notification = await prisma.notification.findFirst({ where: { userId: patient.id, title: 'Your visit summary is ready' } });
    expect(notification.message).not.toContain(PRIVATE);

    const mine = await request(app).get(`${BASE}/mine/${appt.id}`).set('Authorization', patient.auth);
    expect(mine.status).toBe(200);
    expect(mine.body.data).toMatchObject({ version: 1, updated: false, doctor: { name: doctor.name }, summary: { summary: 'We discussed your symptoms.', followUp: { needed: true, timeframe: 'In two weeks' } } });
    expect(JSON.stringify(mine.body)).not.toContain(PRIVATE);

    // Another patient cannot read it.
    const stranger = await account('stranger');
    expect((await request(app).get(`${BASE}/mine/${appt.id}`).set('Authorization', stranger.auth)).status).toBe(404);
  });

  it('rejects stale revisions and a second note for the same appointment', async () => {
    const appt = await appointment(doctor, patient);
    expect((await save(doctor, appt.id, { content: full() })).status).toBe(200);
    const stale = await save(doctor, appt.id, { revision: 7, content: full() });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE');
    // A client that believes no note exists yet (no revision) must not create a second one.
    const duplicate = await save(doctor, appt.id, { content: full() });
    expect(duplicate.status).toBe(409);
    expect(await prisma.consultationNote.count({ where: { appointmentId: appt.id } })).toBe(1);
  });

  it('amends with a reason and a real change, keeping every signed version', async () => {
    const appt = await appointment(doctor, patient, { status: 'COMPLETED' });
    await save(doctor, appt.id, { content: full() });
    await sign(doctor, appt.id, { revision: 1 });

    const noReason = await sign(doctor, appt.id, { revision: 2 });
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe('AMENDMENT_REASON_REQUIRED');
    const unchanged = await sign(doctor, appt.id, { revision: 2, amendmentReason: 'Correcting the advice' });
    expect(unchanged.status).toBe(409);
    expect(unchanged.body.code).toBe('NO_CHANGES');

    const edited = await save(doctor, appt.id, { revision: 2, content: full({ patient: { ...full().patient, advice: 'Rest, water, and paracetamol if needed.' } }) });
    expect(edited.body.data.note.hasUnsignedChanges).toBe(true);
    const amended = await sign(doctor, appt.id, { revision: 3, amendmentReason: 'Correcting the advice' });
    expect(amended.status).toBe(200);
    expect(amended.body.data.note.versions.map((v) => v.number)).toEqual([2, 1]);
    expect(amended.body.data.note.versions[0].amendmentReason).toBe('Correcting the advice');

    const mine = await request(app).get(`${BASE}/mine/${appt.id}`).set('Authorization', patient.auth);
    expect(mine.body.data).toMatchObject({ version: 2, updated: true, summary: { advice: 'Rest, water, and paracetamol if needed.' } });
    expect(mine.body.data.history.map((h) => h.version)).toEqual([2, 1]);
    // The doctor's amendment reason stays in the clinical record.
    expect(JSON.stringify(mine.body)).not.toContain('Correcting the advice');
  });
});

describe('the doctor\'s worklist', () => {
  it('lists completed consultations still waiting for a signed note, and earlier notes for the same patient', async () => {
    const first = await appointment(doctor, patient, { status: 'COMPLETED' });
    const second = await appointment(doctor, patient, { status: 'COMPLETED' });
    const list = async () => (await request(app).get(`${BASE}/practice`).set('Authorization', doctor.auth)).body.data;

    expect((await list()).awaiting.map((a) => a.appointmentId)).toEqual(expect.arrayContaining([first.id, second.id]));
    await save(doctor, first.id, { content: full() });
    expect((await list()).awaiting.map((a) => a.appointmentId)).toContain(first.id); // a draft is not a signed note
    await sign(doctor, first.id, { revision: 1 });
    const after = await list();
    expect(after.awaiting.map((a) => a.appointmentId)).not.toContain(first.id);
    expect(after.items.find((n) => n.appointmentId === first.id)).toMatchObject({ signedVersion: 1, hasUnsignedChanges: false });

    const next = await detail(doctor, second.id);
    expect(next.body.data.previous.map((p) => p.appointmentId)).toContain(first.id);
    expect(next.body.data.note).toBeNull();
    // Another doctor's list never shows these patients.
    const theirs = (await request(app).get(`${BASE}/practice`).set('Authorization', otherDoctor.auth)).body.data;
    expect(JSON.stringify(theirs)).not.toContain(first.id);
  });
});

describe('database-enforced invariants', () => {
  it('signed versions cannot be edited or deleted', async () => {
    const appt = await appointment(doctor, patient, { status: 'COMPLETED' });
    await save(doctor, appt.id, { content: full() });
    await sign(doctor, appt.id, { revision: 1 });
    const version = await prisma.consultationNoteVersion.findFirst({ where: { note: { appointmentId: appt.id } } });
    await expect(prisma.consultationNoteVersion.update({ where: { id: version.id }, data: { content: {} } })).rejects.toThrow(/append-only/);
    await expect(prisma.consultationNoteVersion.delete({ where: { id: version.id } })).rejects.toThrow(/append-only/);
  });

  it('a note\'s patient and doctor must be the appointment\'s', async () => {
    const appt = await appointment(doctor, patient);
    const other = await account('other-patient');
    await expect(prisma.consultationNote.create({ data: { appointmentId: appt.id, doctorProfileId: doctor.profileId, patientId: other.id, draft: {} } })).rejects.toThrow();
    await expect(prisma.consultationNote.create({ data: { appointmentId: appt.id, doctorProfileId: otherDoctor.profileId, patientId: patient.id, draft: {} } })).rejects.toThrow();
  });

  it('the first signature carries no amendment reason; later ones must', async () => {
    const appt = await appointment(doctor, patient, { status: 'COMPLETED' });
    const note = await prisma.consultationNote.create({ data: { appointmentId: appt.id, doctorProfileId: doctor.profileId, patientId: patient.id, draft: {} } });
    await expect(prisma.consultationNoteVersion.create({ data: { noteId: note.id, number: 1, content: {}, amendmentReason: 'not allowed' } })).rejects.toThrow();
    await prisma.consultationNoteVersion.create({ data: { noteId: note.id, number: 1, content: {} } });
    await expect(prisma.consultationNoteVersion.create({ data: { noteId: note.id, number: 2, content: {} } })).rejects.toThrow();
  });
});
