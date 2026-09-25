import prisma from "../../config/db.js";
export const transaction = (work) =>
  prisma.$transaction(work, { isolationLevel: "Serializable" });
const scope = (ownerId) => ({
  type: "HOSPITAL",
  status: "VERIFIED",
  ...(ownerId ? { ownerId } : {}),
});
export const patient = (tx, userId) =>
  tx.userRole.findFirst({
    where: { userId, role: "PATIENT" },
    select: { id: true },
  });
export const owner = (tx, userId) =>
  tx.userRole.findFirst({
    where: { userId, role: "ORGANISATION_OWNER" },
    select: { id: true },
  });
export const dependent = (tx, id, patientId) =>
  tx.dependentProfile.findFirst({
    where: { id, patientId },
    select: { id: true },
  });
export const activeEnrollment = (tx, patientId, hospitalId, dependentId) =>
  tx.hospitalEnrollment.findFirst({
    where: {
      patientId,
      hospitalId,
      dependentId: dependentId ?? null,
      status: "ACTIVE",
      hospital: scope(),
    },
    select: { id: true },
  });
const patientSelect = {
  id: true,
  hospitalId: true,
  dependentId: true,
  status: true,
  requestedAt: true,
  appointmentType: true,
  reason: true,
  checkedInAt: true,
  createdAt: true,
  updatedAt: true,
  dependent: { select: { id: true, fullName: true } },
  hospital: { select: { id: true, name: true } },
};
const queueSelect = {
  id: true,
  patientId: true,
  dependentId: true,
  status: true,
  requestedAt: true,
  appointmentType: true,
  reason: true,
  createdAt: true,
  dependent: { select: { id: true, fullName: true } },
  patient: { select: { id: true, full_name: true } },
};
export const create = (tx, data) =>
  tx.hospitalAppointment.create({ data, select: patientSelect });
export const patientDetail = (tx, id, patientId) =>
  tx.hospitalAppointment.findFirst({
    where: { id, patientId },
    select: patientSelect,
  });
export const patientList = async (tx, patientId, query) => {
  const where = {
    patientId,
    ...(query.status ? { status: query.status } : {}),
  };
  const [items, total] = await Promise.all([
    tx.hospitalAppointment.findMany({
      where,
      select: patientSelect,
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
      take: query.limit,
      skip: query.offset,
    }),
    tx.hospitalAppointment.count({ where }),
  ]);
  return { items, total, limit: query.limit, offset: query.offset };
};
export const queue = async (tx, userId, query) => {
  const where = {
    hospital: scope(userId),
    ...(query.status ? { status: query.status } : {}),
  };
  const [items, total] = await Promise.all([
    tx.hospitalAppointment.findMany({
      where,
      select: queueSelect,
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
      take: query.limit,
      skip: query.offset,
    }),
    tx.hospitalAppointment.count({ where }),
  ]);
  return { items, total, limit: query.limit, offset: query.offset };
};
export const transition = (tx, id, userId, from, data) =>
  tx.hospitalAppointment.updateMany({
    where: { id, status: from, hospital: scope(userId) },
    data,
  });
export const checkIn = (tx, id, userId) =>
  tx.hospitalAppointment.updateMany({
    where: { id, patientId: userId, status: "SCHEDULED" },
    data: { status: "CHECKED_IN", checkedInAt: new Date() },
  });
export const audit = (tx, userId, type, appointmentId) =>
  tx.activityLog.create({
    data: {
      userId,
      type,
      description: "Hospital appointment state changed",
      meta: { appointmentId },
    },
  });
