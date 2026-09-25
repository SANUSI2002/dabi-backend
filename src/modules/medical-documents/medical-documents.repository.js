import prisma from "../../config/db.js";

export const safeDocumentSelect = {
  id: true,
  originalFilename: true,
  declaredContentType: true,
  validatedContentType: true,
  byteSize: true,
  kind: true,
  status: true,
  medicalRecordId: true,
  scanVerdict: true,
  scanRequestedAt: true,
  scannedAt: true,
  sha256: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
};
export const internalDocumentSelect = {
  ...safeDocumentSelect,
  ownerPatientId: true,
  objectKey: true,
};
export const audit = (tx, userId, action, documentId, shareId) =>
  tx.activityLog.create({
    data: {
      userId,
      type: action,
      description: "Medical document lifecycle event",
      meta: { documentId, ...(shareId ? { shareId } : {}) },
    },
    select: { id: true },
  });
export const transaction = (fn) => prisma.$transaction(fn);
export const isPatient = (tx, userId) =>
  tx.userRole.findFirst({
    where: { userId, role: "PATIENT" },
    select: { id: true },
  });
export const ownedRecord = (tx, userId, id) =>
  tx.medicalRecord.findFirst({ where: { id, userId }, select: { id: true } });
export const create = (tx, data) =>
  tx.medicalDocument.create({ data, select: internalDocumentSelect });
export const owned = (client, ownerPatientId, id) =>
  client.medicalDocument.findFirst({
    where: { id, ownerPatientId, status: { not: "DELETED" } },
    select: internalDocumentSelect,
  });
export const listOwned = async (ownerPatientId, q) => {
  const where = {
    ownerPatientId,
    status: q.status || { not: "DELETED" },
    ...(q.kind ? { kind: q.kind } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.medicalDocument.findMany({
      where,
      select: safeDocumentSelect,
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.medicalDocument.count({ where }),
  ]);
  return { items, page: q.page, limit: q.limit, total };
};
export const updateState = (tx, id, ownerPatientId, status, data) =>
  tx.medicalDocument.updateMany({
    where: { id, ownerPatientId, status },
    data,
  });
export const findScanDocument = (tx, id) =>
  tx.medicalDocument.findUnique({
    where: { id },
    select: internalDocumentSelect,
  });
export const recipientEligible = async (tx, patientId, recipientId) => {
  const doctor = await tx.doctorCareRelationship.findFirst({
    where: {
      patientId,
      status: "ACTIVE",
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      doctorProfile: {
        userId: recipientId,
        professionType: "DOCTOR",
        verificationStatus: "VERIFIED",
      },
    },
    select: { id: true },
  });
  if (doctor) return true;
  return Boolean(
    await tx.careRelationship.findFirst({
      where: {
        patientId,
        caregiverId: recipientId,
        status: "ACTIVE",
        revokedAt: null,
        permissions: { has: "RECORDS" },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true },
    }),
  );
};
export const emergencySummary = (userId) =>
  prisma.user.findUnique({
    where: { id: userId },
    select: {
      patientId: true,
      full_name: true,
      dob: true,
      profile: {
        select: {
          blood_type: true,
          chronic_conditions: true,
          known_allergies: true,
          emergencyContactName: true,
          emergencyContactPhone: true,
          emergencyContactRelation: true,
          emergency_access_permissions: true,
          electronic_health_records: true,
          consentGiven: true,
        },
      },
    },
  });
export { prisma };
