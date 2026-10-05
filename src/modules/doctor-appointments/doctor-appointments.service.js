// Doctor booking: verified doctors publish availability slots; patients book a slot for themselves
// or a dependent; the doctor confirms (optionally adding a video link), declines, cancels or completes.
//
// Invariants
// - Only verified DOCTOR professional profiles can publish slots or act on appointments.
// - A slot holds at most one REQUESTED/CONFIRMED appointment (partial unique index), so two
//   patients racing for the same slot cannot both win: the loser gets SLOT_TAKEN.
// - Every transition is a guarded updateMany on the expected current status, so concurrent
//   actions cannot move an appointment through an invalid transition.
// - Doctors see only the minimum identity of their own patients (name + Sabi patient ID).
import prisma from '../../config/db.js';

const DAY = 86400000;
const ACTIVE = ['REQUESTED', 'CONFIRMED'];
export const fail = (code) => Object.assign(new Error(code), { code });
const transaction = (work) => prisma.$transaction(work, { isolationLevel: 'Serializable' });
const audit = (tx, userId, type, id) => tx.activityLog.create({ data: { userId, type, description: 'Doctor appointment changed', meta: { id } } });
const changed = (result) => { if (result.count !== 1) throw fail('INVALID_STATE'); };

const doctorSummary = { id: true, specialty: true, practiceName: true, practiceAddress: true, user: { select: { full_name: true } } };
const patientView = {
  id: true, dependentId: true, doctorProfileId: true, slotId: true, startsAt: true, endsAt: true, consultationType: true,
  reason: true, status: true, decisionReason: true, meetingUrl: true, cancelledBy: true, confirmedAt: true, cancelledAt: true,
  completedAt: true, createdAt: true,
  doctorProfile: { select: doctorSummary },
  dependent: { select: { id: true, fullName: true } },
};
const doctorView = {
  id: true, dependentId: true, slotId: true, startsAt: true, endsAt: true, consultationType: true, reason: true, status: true,
  decisionReason: true, meetingUrl: true, cancelledBy: true, confirmedAt: true, cancelledAt: true, completedAt: true, createdAt: true,
  patient: { select: { id: true, full_name: true, patientId: true } },
  dependent: { select: { fullName: true, dateOfBirth: true } },
};
const slotView = { id: true, startsAt: true, endsAt: true, consultationTypes: true, cancelledAt: true };

const toDoctor = (p) => p && ({ id: p.id, name: p.user?.full_name ?? null, specialty: p.specialty, practiceName: p.practiceName, practiceAddress: p.practiceAddress });
const toPatientAppointment = ({ doctorProfile, ...a }) => ({ ...a, doctor: toDoctor(doctorProfile) });
const toDoctorAppointment = ({ patient, dependent, ...a }) => ({
  ...a,
  patient: { userId: patient?.id ?? null, name: patient?.full_name ?? null, patientId: patient?.patientId ?? null },
  dependent: dependent ? { name: dependent.fullName, dateOfBirth: dependent.dateOfBirth } : null,
});

const isPatient = (tx, userId) => tx.userRole.findFirst({ where: { userId, role: 'PATIENT' }, select: { id: true } });
const verifiedDoctor = (tx, where) => tx.professionalProfile.findFirst({ where: { ...where, professionType: 'DOCTOR', verificationStatus: 'VERIFIED' }, select: { id: true } });
const requireDoctor = async (tx, userId) => {
  const doctor = await verifiedDoctor(tx, { userId });
  if (!doctor) throw fail('FORBIDDEN');
  return doctor.id;
};
const openSlotWhere = (now = new Date()) => ({ cancelledAt: null, startsAt: { gt: now }, appointments: { none: { status: { in: ACTIVE } } } });

// ---------------- Public / patient ----------------

/** Open, bookable slots for a verified doctor (default: the next 14 days). */
export const doctorSlots = async (doctorId, query) => {
  const doctor = await verifiedDoctor(prisma, { id: doctorId });
  if (!doctor) throw fail('NOT_FOUND');
  const now = new Date();
  const from = query.from && new Date(query.from) > now ? new Date(query.from) : now;
  const to = query.to ? new Date(query.to) : new Date(from.getTime() + 14 * DAY);
  const items = await prisma.doctorAvailabilitySlot.findMany({
    where: { doctorProfileId: doctorId, ...openSlotWhere(now), startsAt: { gt: now, gte: from, lt: to } },
    select: { id: true, startsAt: true, endsAt: true, consultationTypes: true },
    orderBy: { startsAt: 'asc' },
  });
  return { items, from, to };
};

/** Earliest open slot per doctor, for directory listings. */
export const nextAvailable = async (doctorIds) => {
  if (!doctorIds.length) return new Map();
  const rows = await prisma.doctorAvailabilitySlot.findMany({
    where: { doctorProfileId: { in: doctorIds }, ...openSlotWhere() },
    select: { doctorProfileId: true, startsAt: true },
    orderBy: [{ doctorProfileId: 'asc' }, { startsAt: 'asc' }],
    distinct: ['doctorProfileId'],
  });
  return new Map(rows.map((r) => [r.doctorProfileId, r.startsAt]));
};

const createBooking = async (tx, patientId, { slotId, consultationType, reason, dependentId }, sameDoctorAs) => {
  const slot = await tx.doctorAvailabilitySlot.findFirst({
    where: { id: slotId, ...openSlotWhere(), doctorProfile: { professionType: 'DOCTOR', verificationStatus: 'VERIFIED' } },
    select: { id: true, doctorProfileId: true, startsAt: true, endsAt: true, consultationTypes: true },
  });
  if (!slot) throw fail('SLOT_UNAVAILABLE');
  if (sameDoctorAs && slot.doctorProfileId !== sameDoctorAs) throw fail('SLOT_UNAVAILABLE');
  if (!slot.consultationTypes.includes(consultationType)) throw fail('TYPE_NOT_OFFERED');
  if (dependentId && !(await tx.dependentProfile.findFirst({ where: { id: dependentId, patientId }, select: { id: true } }))) throw fail('NOT_FOUND');
  return tx.doctorAppointment.create({
    data: {
      patientId, dependentId: dependentId ?? null, doctorProfileId: slot.doctorProfileId, slotId: slot.id,
      startsAt: slot.startsAt, endsAt: slot.endsAt, consultationType, reason: reason ?? null,
    },
    select: patientView,
  });
};

export const book = (patientId, data) => transaction(async (tx) => {
  if (!(await isPatient(tx, patientId))) throw fail('FORBIDDEN');
  const item = await createBooking(tx, patientId, data);
  await audit(tx, patientId, 'DOCTOR_APPOINTMENT_REQUESTED', item.id);
  return toPatientAppointment(item);
});

export const mine = async (patientId, q) => {
  const where = {
    patientId,
    ...(q.status ? { status: q.status } : {}),
    ...(q.upcoming === 'true' ? { endsAt: { gt: new Date() }, status: q.status ?? { in: ACTIVE } } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.doctorAppointment.findMany({ where, select: patientView, orderBy: { startsAt: q.upcoming === 'true' ? 'asc' : 'desc' }, take: q.limit, skip: q.offset }),
    prisma.doctorAppointment.count({ where }),
  ]);
  return { items: items.map(toPatientAppointment), total, limit: q.limit, offset: q.offset };
};

export const detail = async (patientId, id) => {
  const item = await prisma.doctorAppointment.findFirst({ where: { id, patientId }, select: patientView });
  if (!item) throw fail('NOT_FOUND');
  return toPatientAppointment(item);
};

export const patientCancel = (patientId, id, { reason }) => transaction(async (tx) => {
  changed(await tx.doctorAppointment.updateMany({
    where: { id, patientId, status: { in: ACTIVE }, startsAt: { gt: new Date() } },
    data: { status: 'CANCELLED', cancelledBy: 'PATIENT', cancelledAt: new Date(), decisionReason: reason ?? null },
  }));
  await audit(tx, patientId, 'DOCTOR_APPOINTMENT_CANCELLED', id);
  return toPatientAppointment(await tx.doctorAppointment.findFirst({ where: { id, patientId }, select: patientView }));
});

/** Moves an active booking to another open slot with the same doctor; the new booking needs confirming again. */
export const reschedule = (patientId, id, data) => transaction(async (tx) => {
  const current = await tx.doctorAppointment.findFirst({
    where: { id, patientId, status: { in: ACTIVE }, startsAt: { gt: new Date() } },
    select: { id: true, doctorProfileId: true, dependentId: true, consultationType: true, reason: true },
  });
  if (!current) throw fail('INVALID_STATE');
  changed(await tx.doctorAppointment.updateMany({
    where: { id, patientId, status: { in: ACTIVE } },
    data: { status: 'CANCELLED', cancelledBy: 'PATIENT', cancelledAt: new Date(), decisionReason: 'Rescheduled by patient' },
  }));
  const item = await createBooking(tx, patientId, {
    slotId: data.slotId,
    consultationType: data.consultationType ?? current.consultationType,
    reason: data.reason ?? current.reason ?? undefined,
    dependentId: current.dependentId ?? undefined,
  }, current.doctorProfileId);
  await audit(tx, patientId, 'DOCTOR_APPOINTMENT_RESCHEDULED', item.id);
  return toPatientAppointment(item);
});

// ---------------- Doctor workspace ----------------

const publicProfileSelect = {
  id: true, specialty: true, practiceName: true, verificationStatus: true, bio: true, yearsOfExperience: true,
  consultationFeeMinor: true, consultationTypes: true, practiceAddress: true, user: { select: { full_name: true } },
};

export const practiceProfile = async (userId) => {
  const profile = await prisma.professionalProfile.findFirst({ where: { userId, professionType: 'DOCTOR' }, select: publicProfileSelect });
  if (!profile) throw fail('FORBIDDEN');
  return profile;
};

export const updatePracticeProfile = (userId, data) => transaction(async (tx) => {
  const doctorId = await requireDoctor(tx, userId);
  await tx.professionalProfile.update({ where: { id: doctorId }, data });
  await audit(tx, userId, 'DOCTOR_PROFILE_UPDATED', doctorId);
  return tx.professionalProfile.findFirst({ where: { id: doctorId }, select: publicProfileSelect });
});

export const practiceSlots = async (userId, query) => {
  const doctorId = await requireDoctor(prisma, userId);
  const from = query.from ? new Date(query.from) : new Date(Date.now() - DAY);
  const to = query.to ? new Date(query.to) : new Date(from.getTime() + 31 * DAY);
  const slots = await prisma.doctorAvailabilitySlot.findMany({
    where: { doctorProfileId: doctorId, startsAt: { gte: from, lt: to } },
    select: { ...slotView, appointments: { where: { status: { in: ACTIVE } }, select: { id: true, status: true } } },
    orderBy: { startsAt: 'asc' },
  });
  return {
    items: slots.map(({ appointments, ...slot }) => ({
      ...slot,
      state: slot.cancelledAt ? 'CANCELLED' : appointments[0] ? (appointments[0].status === 'CONFIRMED' ? 'BOOKED' : 'REQUESTED') : 'OPEN',
      appointmentId: appointments[0]?.id ?? null,
    })),
    from, to,
  };
};

export const createSlots = (userId, { slots }) => transaction(async (tx) => {
  const doctorId = await requireDoctor(tx, userId);
  for (const slot of slots) {
    const overlap = await tx.doctorAvailabilitySlot.findFirst({
      where: { doctorProfileId: doctorId, cancelledAt: null, startsAt: { lt: new Date(slot.endsAt) }, endsAt: { gt: new Date(slot.startsAt) } },
      select: { id: true },
    });
    if (overlap) throw fail('SLOT_OVERLAP');
  }
  const created = [];
  for (const slot of slots) {
    created.push(await tx.doctorAvailabilitySlot.create({
      data: { doctorProfileId: doctorId, startsAt: new Date(slot.startsAt), endsAt: new Date(slot.endsAt), consultationTypes: slot.consultationTypes },
      select: slotView,
    }));
  }
  await audit(tx, userId, 'DOCTOR_SLOTS_PUBLISHED', doctorId);
  return { items: created };
});

export const cancelSlot = (userId, id) => transaction(async (tx) => {
  const doctorId = await requireDoctor(tx, userId);
  const slot = await tx.doctorAvailabilitySlot.findFirst({ where: { id, doctorProfileId: doctorId, cancelledAt: null }, select: { id: true } });
  if (!slot) throw fail('NOT_FOUND');
  if (await tx.doctorAppointment.findFirst({ where: { slotId: id, status: { in: ACTIVE } }, select: { id: true } })) throw fail('SLOT_BOOKED');
  await tx.doctorAvailabilitySlot.update({ where: { id }, data: { cancelledAt: new Date() } });
  await audit(tx, userId, 'DOCTOR_SLOT_CANCELLED', id);
  return { id, cancelled: true };
});

export const practiceQueue = async (userId, q) => {
  const doctorId = await requireDoctor(prisma, userId);
  const where = { doctorProfileId: doctorId, ...(q.status ? { status: q.status } : {}), ...(q.from ? { startsAt: { gte: new Date(q.from) } } : {}) };
  const [items, total] = await Promise.all([
    prisma.doctorAppointment.findMany({ where, select: doctorView, orderBy: { startsAt: 'asc' }, take: q.limit, skip: q.offset }),
    prisma.doctorAppointment.count({ where }),
  ]);
  return { items: items.map(toDoctorAppointment), total, limit: q.limit, offset: q.offset };
};

export const practiceAppointmentDetail = async (userId, id) => {
  const doctorId = await requireDoctor(prisma, userId);
  const item = await prisma.doctorAppointment.findFirst({ where: { id, doctorProfileId: doctorId }, select: doctorView });
  if (!item) throw fail('NOT_FOUND');
  return toDoctorAppointment(item);
};

const doctorTransition = (type, buildWhere, buildData) => (userId, id, body = {}) => transaction(async (tx) => {
  const doctorId = await requireDoctor(tx, userId);
  const exists = await tx.doctorAppointment.findFirst({ where: { id, doctorProfileId: doctorId }, select: { id: true } });
  if (!exists) throw fail('NOT_FOUND');
  changed(await tx.doctorAppointment.updateMany({ where: { id, doctorProfileId: doctorId, ...buildWhere() }, data: buildData(body) }));
  await audit(tx, userId, type, id);
  return toDoctorAppointment(await tx.doctorAppointment.findFirst({ where: { id }, select: doctorView }));
});

export const confirm = doctorTransition(
  'DOCTOR_APPOINTMENT_CONFIRMED',
  () => ({ status: 'REQUESTED', startsAt: { gt: new Date() } }),
  ({ meetingUrl }) => ({ status: 'CONFIRMED', confirmedAt: new Date(), ...(meetingUrl ? { meetingUrl } : {}) }),
);
export const setMeetingLink = doctorTransition(
  'DOCTOR_APPOINTMENT_LINK_UPDATED',
  () => ({ status: 'CONFIRMED', consultationType: 'VIRTUAL' }),
  ({ meetingUrl }) => ({ meetingUrl }),
);
export const decline = doctorTransition(
  'DOCTOR_APPOINTMENT_DECLINED',
  () => ({ status: 'REQUESTED' }),
  ({ reason }) => ({ status: 'DECLINED', decisionReason: reason }),
);
export const doctorCancel = doctorTransition(
  'DOCTOR_APPOINTMENT_CANCELLED',
  () => ({ status: { in: ACTIVE }, startsAt: { gt: new Date() } }),
  ({ reason }) => ({ status: 'CANCELLED', cancelledBy: 'DOCTOR', cancelledAt: new Date(), decisionReason: reason }),
);
export const complete = doctorTransition(
  'DOCTOR_APPOINTMENT_COMPLETED',
  () => ({ status: 'CONFIRMED', startsAt: { lte: new Date() } }),
  () => ({ status: 'COMPLETED', completedAt: new Date() }),
);
