import prisma from "../../config/db.js";
export const transaction = (cb) => prisma.$transaction(cb);
export const inventory = (tx, id, pharmacyId) =>
  tx.pharmacyInventoryItem.findFirst({
    where: {
      id,
      pharmacyId,
      isActive: true,
      pharmacy: { complianceStatus: "VERIFIED" },
      OR: [
        { pharmacy: { tierLevel: null } },
        {
          batchNumber: { not: null },
          expiryDate: { gt: new Date() },
          branch: { status: "VERIFIED", licenceExpiresAt: { gt: new Date() } },
          pharmacy: {
            superintendentLicenceExpiresAt: { gt: new Date() },
            admin: { accountStatus: "ACTIVE" },
            tier: { enabled: true },
          },
        },
      ],
    },
    select: {
      id: true,
      medicationName: true,
      genericName: true,
      availableQuantity: true,
    },
  });
export const list = (where) =>
  prisma.prescriptionRequest.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
const patientPharmacy = {
  select: {
    id: true,
    name: true,
    address: true,
    city: true,
    state: true,
    latitude: true,
    longitude: true,
  },
};
export const patientRequests = (patientId) =>
  prisma.prescriptionRequest.findMany({
    where: { patientId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      prescriptionId: true,
      status: true,
      createdAt: true,
      pharmacy: patientPharmacy,
    },
  });
export const patientPrescription = (id, u) =>
  prisma.prescription.findFirst({
    where: { id, patientId: u, status: "ISSUED" },
    select: { id: true, items: { select: { id: true, quantity: true } } },
  });
export const pharmacies = (ids) =>
  prisma.pharmacy.findMany({
    where: { id: { in: ids }, complianceStatus: "VERIFIED" },
    select: { id: true },
  });
export const requests = (tx, data) =>
  tx.prescriptionRequest.createMany({ data, skipDuplicates: true });
export const invite = (tx, data) => tx.pharmacyStaffMember.create({ data });
export const pharmacist = (tx, u) =>
  tx.professionalProfile.findFirst({
    where: {
      userId: u,
      professionType: "PHARMACIST",
      verificationStatus: "VERIFIED",
    },
    select: { id: true },
  });
export const accept = (tx, id, u) =>
  tx.pharmacyStaffMember.updateMany({
    where: {
      id,
      pharmacistUserId: u,
      status: "PENDING",
      pharmacy: { complianceStatus: "VERIFIED" },
      pharmacist: {
        accountStatus: "ACTIVE",
        professionalProfile: {
          professionType: "PHARMACIST",
          verificationStatus: "VERIFIED",
        },
      },
    },
    data: { status: "ACTIVE", acceptedAt: new Date() },
  });
export const request = (tx, id, pharmacyId) =>
  tx.prescriptionRequest.findFirst({
    where: {
      id,
      pharmacyId,
      status: { not: "CANCELLED" },
      prescription: { status: "ISSUED" },
    },
    select: {
      id: true,
      prescription: {
        select: {
          items: { select: { id: true, quantity: true, medicationName: true } },
        },
      },
    },
  });
export const replace = (tx, id) =>
  tx.pharmacyQuote.updateMany({
    where: { requestId: id, status: "ISSUED" },
    data: { status: "REPLACED" },
  });
export const latest = (tx, id) =>
  tx.pharmacyQuote.aggregate({
    where: { requestId: id },
    _max: { revision: true },
  });
export const createQuote = (tx, data) => tx.pharmacyQuote.create({ data });
export const patientQuotes = (u) =>
  prisma.pharmacyQuote.findMany({
    where: {
      status: "ISSUED",
      quoteExpiresAt: { gt: new Date() },
      request: { patientId: u },
    },
    orderBy: { quoteExpiresAt: "asc" },
    include: {
      items: true,
      request: {
        select: { id: true, prescriptionId: true, pharmacy: patientPharmacy },
      },
    },
  });
