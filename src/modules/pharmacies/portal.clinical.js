import prisma from "../../config/db.js";
import { fail } from "./portal.policy.js";
import { owner, audit } from "./portal.service.js";
import * as requests from "../pharmacy-requests/pharmacy-requests.service.js";
import { stagePharmacyProfessional } from "../identity/identity.repository.js";

const professional = {
  accountStatus: "ACTIVE",
  professionalProfile: {
    professionType: "PHARMACIST",
    verificationStatus: "VERIFIED",
  },
};
export async function clinicalAccess(tx, userId, pharmacyId, organizationId) {
  const staff = await tx.pharmacyStaffMember.findFirst({
    where: {
      pharmacistUserId: userId,
      pharmacyId,
      status: "ACTIVE",
      pharmacist: professional,
      pharmacy: {
        complianceStatus: "VERIFIED",
        identityOrganization: {
          ...(organizationId ? { id: organizationId } : {}),
          memberships: {
            some: {
              userId,
              status: "ACTIVE",
              roles: { some: { roleCode: "PHARMACIST" } },
            },
          },
        },
      },
    },
    select: { id: true, pharmacyId: true },
  });
  if (!staff)
    fail("An active verified pharmacist membership is required.", 403);
  return staff;
}
export async function workspaces(userId) {
  const managed = await prisma.pharmacy.findMany({
    where: {
      adminUserId: userId,
      admin: { accountStatus: "ACTIVE" },
      identityOrganization: {
        memberships: {
          some: {
            userId,
            status: "ACTIVE",
            roles: { some: { roleCode: "PHARMACY_ADMIN" } },
          },
        },
      },
    },
    select: { id: true, name: true },
  });
  const staff = await prisma.pharmacyStaffMember.findMany({
    where: {
      pharmacistUserId: userId,
      status: { in: ["PENDING", "ACTIVE"] },
      pharmacist: professional,
      pharmacy: { complianceStatus: "VERIFIED" },
    },
    select: {
      id: true,
      status: true,
      pharmacy: { select: { id: true, name: true } },
    },
  });
  const operations = await prisma.pharmacy.findMany({
    where: {
      complianceStatus: "VERIFIED",
      identityOrganization: {
        memberships: {
          some: {
            userId,
            status: "ACTIVE",
            user: { accountStatus: "ACTIVE" },
            roles: { some: { roleCode: "PHARMACY_STAFF" } },
          },
        },
      },
    },
    select: { id: true, name: true },
  });
  return {
    items: [
      ...managed.map((p) => ({ ...p, kind: "OWNER" })),
      ...operations.map((p) => ({ ...p, kind: "STAFF" })),
      ...staff
        .filter((s) => s.status === "ACTIVE")
        .map((s) => ({ ...s.pharmacy, kind: "PHARMACIST" })),
    ],
    invitations: staff
      .filter((s) => s.status === "PENDING")
      .map((s) => ({ id: s.id, pharmacy: s.pharmacy })),
  };
}
export async function invitePharmacist(userId, organizationId, email) {
  return prisma.$transaction(async (tx) => {
    const p = await owner(tx, userId, organizationId, { lock: true });
    if (p.complianceStatus !== "VERIFIED")
      fail("The pharmacy must be approved before inviting a pharmacist.");
    const pharmacist = await tx.user.findFirst({
      where: { email: email.toLowerCase(), ...professional },
      select: { id: true },
    });
    if (!pharmacist)
      fail("No eligible verified pharmacist account was found.", 404);
    const prior = await tx.pharmacyStaffMember.findUnique({
      where: {
        pharmacyId_pharmacistUserId: {
          pharmacyId: p.id,
          pharmacistUserId: pharmacist.id,
        },
      },
    });
    if (prior && ["ACTIVE", "PENDING"].includes(prior.status))
      fail("This pharmacist is already invited or active.");
    const member = await tx.pharmacyStaffMember.upsert({
      where: {
        pharmacyId_pharmacistUserId: {
          pharmacyId: p.id,
          pharmacistUserId: pharmacist.id,
        },
      },
      create: { pharmacyId: p.id, pharmacistUserId: pharmacist.id },
      update: { status: "PENDING", acceptedAt: null },
    });
    await stagePharmacyProfessional(tx, p.id, pharmacist.id);
    await audit(tx, userId, "PHARMACIST_INVITED", {
      pharmacyId: p.id,
      memberId: member.id,
    });
    return { id: member.id, status: "PENDING" };
  });
}
export async function acceptPharmacist(userId, id) {
  const eligible = await prisma.pharmacyStaffMember.findFirst({
    where: {
      id,
      pharmacistUserId: userId,
      status: "PENDING",
      pharmacist: professional,
      pharmacy: { complianceStatus: "VERIFIED" },
    },
    select: { id: true },
  });
  if (!eligible) fail("This invitation is not available.", 403);
  await requests.accept(userId, id);
  return { accepted: true };
}
export async function clinicalRequests(userId, pharmacyId, org) {
  return prisma.$transaction(async (tx) => {
    await clinicalAccess(tx, userId, pharmacyId, org);
    const rows = await tx.prescriptionRequest.findMany({
      where: {
        pharmacyId,
        status: { not: "CANCELLED" },
        prescription: { status: "ISSUED" },
      },
      select: {
        id: true,
        status: true,
        prescription: {
          select: {
            id: true,
            reference: true,
            instructions: true,
            items: {
              select: {
                id: true,
                medicationName: true,
                dosage: true,
                frequency: true,
                route: true,
                duration: true,
                quantity: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const inventory = await tx.pharmacyInventoryItem.findMany({
      where: {
        pharmacyId,
        isActive: true,
        expiryDate: { gt: new Date() },
        batchNumber: { not: null },
        branch: { status: "VERIFIED", licenceExpiresAt: { gt: new Date() } },
      },
      select: {
        id: true,
        medicationName: true,
        genericName: true,
        branchId: true,
        branch: { select: { name: true } },
        expiryDate: true,
        availableQuantity: true,
        unitPriceMinor: true,
      },
      take: 1000,
    });
    await audit(tx, userId, "PHARMACIST_REQUEST_QUEUE_VIEWED", { pharmacyId });
    return { items: rows, inventory };
  });
}
