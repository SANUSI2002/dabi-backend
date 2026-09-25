import prisma from "../../config/db.js";
export const transaction = (work) =>
  prisma.$transaction(work, { isolationLevel: "Serializable" });
export const patient = (tx, userId) =>
  tx.userRole.findFirst({
    where: { userId, role: "PATIENT" },
    select: { id: true },
  });
export const identity = (tx, id) =>
  tx.user.findUnique({ where: { id }, select: { id: true, full_name: true } });
export const grant = (tx, patientId, caregiverId) =>
  tx.careRelationship.findFirst({
    where: {
      patientId,
      caregiverId,
      status: "ACTIVE",
      revokedAt: null,
      permissions: { has: "APPOINTMENTS" },
    },
    select: { id: true, permissions: true },
  });
export const members = (tx, patientId) =>
  tx.careRelationship.findMany({
    where: {
      patientId,
      status: "ACTIVE",
      revokedAt: null,
      caregiverId: { not: null },
    },
    select: { id: true, caregiverId: true, relationshipLabel: true },
    orderBy: { id: "asc" },
  });
export const dependents = (tx, patientId, coManagerId) =>
  tx.dependentProfile.findMany({
    where: {
      patientId,
      ...(coManagerId ? { coManagerIds: { has: coManagerId } } : {}),
    },
    select: { id: true, fullName: true, careType: true },
    orderBy: { id: "asc" },
  });
export const appointments = (tx, userIds, query, upcoming) =>
  tx.appointment.findMany({
    where: {
      userId: { in: userIds },
      time: {
        gte: new Date(query.from),
        ...(!upcoming ? { lt: new Date(query.to) } : {}),
      },
    },
    select: {
      id: true,
      userId: true,
      doctorName: true,
      time: true,
      status: true,
    },
    orderBy: [{ time: "asc" }, { id: "asc" }],
    ...(upcoming ? { take: query.limit + 1, skip: query.offset } : {}),
  });
export const dependentHospitalAppointments = (
  tx,
  patientId,
  dependentIds,
  query,
  upcoming,
) =>
  tx.hospitalAppointment?.findMany({
    where: {
      patientId,
      dependentId: { in: dependentIds },
      requestedAt: {
        gte: new Date(query.from),
        ...(!upcoming ? { lt: new Date(query.to) } : {}),
      },
    },
    select: {
      id: true,
      dependentId: true,
      requestedAt: true,
      status: true,
      appointmentType: true,
    },
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    ...(upcoming ? { take: query.limit + 1, skip: query.offset } : {}),
  }) ?? [];
