import prisma from "../../config/db.js";
export const transaction = (work) =>
  prisma.$transaction(work, { isolationLevel: "Serializable" });
export const hospitalScope = (ownerId) => ({
  type: "HOSPITAL",
  status: "VERIFIED",
  ...(ownerId ? { ownerId } : {}),
});
export const patientSelect = {
  id: true,
  hospitalId: true,
  planId: true,
  dependentId: true,
  status: true,
  patientNote: true,
  decisionReason: true,
  decidedAt: true,
  createdAt: true,
  updatedAt: true,
  dependent: { select: { id: true, fullName: true } },
  hospital: { select: { id: true, name: true } },
  plan: { select: { id: true, name: true, feeMinor: true } },
};
export const ownerSelect = {
  id: true,
  patientId: true,
  dependentId: true,
  status: true,
  patientNote: true,
  createdAt: true,
  updatedAt: true,
  dependent: { select: { id: true, fullName: true } },
  plan: { select: { id: true, name: true, feeMinor: true } },
  patient: { select: { id: true, full_name: true } },
};
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
export const hospital = (tx, id, ownerId) =>
  tx.organisation.findFirst({
    where: { id, ...hospitalScope(ownerId) },
    select: { id: true },
  });
export const ownedHospital = (tx, ownerId) =>
  tx.organisation.findFirst({
    where: hospitalScope(ownerId),
    select: { id: true },
  });
export const plan = (tx, hospitalId, planId) =>
  tx.hospitalMemberPlan.findFirst({
    where: {
      id: planId,
      hospitalId,
      status: "ACTIVE",
      hospital: hospitalScope(),
    },
    select: { id: true },
  });
export const dependent = (tx, id, patientId) =>
  tx.dependentProfile.findFirst({
    where: { id, patientId },
    select: { id: true },
  });
export const open = (tx, patientId, hospitalId, dependentId) =>
  tx.hospitalEnrollment.findFirst({
    where: {
      patientId,
      hospitalId,
      dependentId: dependentId ?? null,
      status: { in: ["PENDING", "ACTIVE"] },
    },
    select: { id: true },
  });
export const create = (tx, data) =>
  tx.hospitalEnrollment.create({ data, select: patientSelect });
export const mine = async (tx, patientId, query) => {
  const where = {
    patientId,
    ...(query.status ? { status: query.status } : {}),
  };
  const [items, total] = await Promise.all([
    tx.hospitalEnrollment.findMany({
      where,
      select: patientSelect,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: query.limit,
      skip: query.offset,
    }),
    tx.hospitalEnrollment.count({ where }),
  ]);
  return { items, total, limit: query.limit, offset: query.offset };
};
export const patientDetail = (tx, id, patientId) =>
  tx.hospitalEnrollment.findFirst({
    where: { id, patientId },
    select: patientSelect,
  });
export const ownerList = async (tx, ownerId, query) => {
  const where = {
    hospital: hospitalScope(ownerId),
    ...(query.status ? { status: query.status } : {}),
  };
  const [items, total] = await Promise.all([
    tx.hospitalEnrollment.findMany({
      where,
      select: ownerSelect,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: query.limit,
      skip: query.offset,
    }),
    tx.hospitalEnrollment.count({ where }),
  ]);
  return { items, total, limit: query.limit, offset: query.offset };
};
export const change = (tx, id, ownerId, status, data) =>
  tx.hospitalEnrollment.updateMany({
    where: { id, status: "PENDING", hospital: hospitalScope(ownerId) },
    data: { status, ...data },
  });
export const audit = (tx, userId, type, enrollmentId) =>
  tx.activityLog.create({
    data: {
      userId,
      type,
      description: "Hospital enrollment state changed",
      meta: { enrollmentId },
    },
  });
