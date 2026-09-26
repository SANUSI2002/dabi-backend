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
// The account holders' own hospital appointments (not booked for a dependent).
export const ownHospitalAppointments = (tx, patientIds, query, upcoming) =>
  tx.hospitalAppointment?.findMany({
    where: {
      patientId: { in: patientIds },
      dependentId: null,
      requestedAt: {
        gte: new Date(query.from),
        ...(!upcoming ? { lt: new Date(query.to) } : {}),
      },
    },
    select: {
      id: true,
      patientId: true,
      requestedAt: true,
      status: true,
      appointmentType: true,
    },
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    ...(upcoming ? { take: query.limit + 1, skip: query.offset } : {}),
  }) ?? [];
// Doctor bookings for the account holders themselves (dependentIds omitted) or for dependents.
export const doctorAppointments = (tx, patientIds, dependentIds, query, upcoming) =>
  tx.doctorAppointment?.findMany({
    where: {
      patientId: { in: patientIds },
      dependentId: dependentIds ? { in: dependentIds } : null,
      startsAt: {
        gte: new Date(query.from),
        ...(!upcoming ? { lt: new Date(query.to) } : {}),
      },
    },
    select: {
      id: true,
      patientId: true,
      dependentId: true,
      startsAt: true,
      status: true,
      consultationType: true,
      doctorProfile: { select: { user: { select: { full_name: true } } } },
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    ...(upcoming ? { take: query.limit + 1, skip: query.offset } : {}),
  }) ?? [];
