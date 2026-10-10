import { randomUUID, createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import sharp from "sharp";
import prisma from "../../config/db.js";
import { registerInTransaction } from "./pharmacies.service.js";
import {
  GLOBAL_CREDENTIALS,
  fail,
  latestCredentials,
  pharmacyBlockers,
  clean,
  distanceKm,
} from "./portal.policy.js";
import {
  PRIVATE_BUCKETS,
  privateStorageClient,
  assertPrivateBucket,
  uploadPrivateObject,
} from "../../config/privateStorage.js";
import {
  evidenceScannerConfigured,
  evidenceUploadMaxBytes,
} from "../../config/evidenceScanner.js";
import * as auth from "../auth/auth.model.js";
import {
  verificationEmailAllowedFor,
  verificationEmailConfigured,
  sendEmailVerificationEmail,
} from "../auth/auth.email.js";

export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const audit = (tx, userId, type, meta) =>
  tx.activityLog.create({
    data: { userId, type, description: "Pharmacy marketplace action", meta },
  });
export const pharmacyInclude = {
  tier: true,
  branches: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
  credentials: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] },
  admin: {
    select: {
      id: true,
      email: true,
      accountStatus: true,
      emailVerifiedAt: true,
    },
  },
};
export const credentialSafe = (doc) => ({
  id: doc.id,
  branchId: doc.branchId,
  kind: doc.kind,
  byteSize: doc.byteSize,
  scanStatus: doc.scanStatus,
  scanErrorCode: doc.scanErrorCode,
  reviewStatus: doc.reviewStatus,
  createdAt: doc.createdAt,
});
export const pharmacySafe = (p) => ({
  id: p.id,
  name: p.name,
  address: p.address,
  city: p.city,
  state: p.state,
  country: p.country,
  contactEmail: p.contactEmail,
  contactPhone: p.contactPhone,
  complianceStatus: p.complianceStatus,
  decisionNote: p.decisionNote,
  tier: p.tier,
  branches: p.branches,
  registrationDetails: p.registrationDetails,
  applicationSubmittedAt: p.applicationSubmittedAt,
  credentials: p.credentials.map(credentialSafe),
  blockers: pharmacyBlockers(p),
});
export async function owner(tx, userId, organizationId, { lock = false } = {}) {
  const p = await tx.pharmacy.findFirst({
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
        ...(organizationId ? { id: organizationId } : {}),
      },
    },
    include: pharmacyInclude,
  });
  if (!p) fail("An active pharmacy administrator membership is required.", 403);
  if (lock) {
    await tx.$queryRaw`SELECT id FROM pharmacies WHERE id=${p.id} FOR UPDATE`;
    return tx.pharmacy.findUnique({
      where: { id: p.id },
      include: pharmacyInclude,
    });
  }
  return p;
}
const portalUrl = () => {
  const value =
    process.env.PHARMACY_PORTAL_URL || "https://pharmacy.sabihealth.org";
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    fail("Pharmacy verification URL is unavailable.", 503);
  return value.replace(/\/$/, "");
};
export async function sendVerification(user) {
  const raw =
    randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  const token = await auth.createEmailVerificationToken(
    user.id,
    hash(raw),
    new Date(Date.now() + 86400000),
  );
  const result = await sendEmailVerificationEmail({
    email: user.email,
    verificationUrl: `${portalUrl()}/pharmacy/verify-email/${user.id}#${raw}`,
  });
  if (result.delivered)
    await auth.revokeOtherEmailVerificationTokens(user.id, token.id);
  else await auth.revokeEmailVerificationToken(token.id);
  return result.delivered;
}
export async function register(input) {
  if (
    !verificationEmailConfigured() ||
    !verificationEmailAllowedFor(input.email)
  )
    fail("Email verification is unavailable. Please try later.", 503);
  portalUrl();
  const p = await prisma.$transaction(async (tx) => {
    const p = await registerInTransaction(tx, input);
    await tx.user.update({
      where: { id: p.adminUserId },
      data: { accountStatus: "PENDING" },
    });
    await tx.pharmacy.update({
      where: { id: p.id },
      data: {
        tierLevel: input.tierLevel,
        registrationDetails: {
          ...input.regulatory,
          termsAcceptedAt: new Date().toISOString(),
          privacyAcceptedAt: new Date().toISOString(),
          consentVersion: "pharmacy-registration-v1",
        },
        superintendentLicenceExpiresAt: new Date(
          input.regulatory.superintendentLicenceExpiresAt,
        ),
      },
    });
    return p;
  });
  const emailSent = await sendVerification({
    id: p.adminUserId,
    email: input.email,
  });
  return {
    id: p.id,
    emailSent,
    message: emailSent
      ? "Registration received. Verify your email to upload credentials."
      : "Registration saved. Email delivery failed; request a fresh verification email.",
  };
}
export const me = (u, org) =>
  prisma.$transaction(async (tx) => pharmacySafe(await owner(tx, u, org)));
export async function addBranch(u, org, input) {
  return prisma.$transaction(async (tx) => {
    const p = await owner(tx, u, org, { lock: true });
    await tx.$queryRaw`SELECT level FROM pharmacy_tiers WHERE level=${p.tierLevel || 1} FOR SHARE`;
    const tier = await tx.pharmacyTier.findUnique({
      where: { level: p.tierLevel || 1 },
    });
    if (!tier?.enabled) fail("This tier is currently unavailable.");
    if (tier.maxBranches && p.branches.length >= tier.maxBranches)
      fail(
        "This tier has reached its branch limit. Ask Sabi operations to review a tier upgrade.",
      );
    const branch = await tx.pharmacyBranch.create({
      data: {
        ...input,
        licenceExpiresAt: new Date(input.licenceExpiresAt),
        pharmacyId: p.id,
      },
    });
    await tx.pharmacy.update({
      where: { id: p.id },
      data: { applicationSubmittedAt: null },
    });
    await audit(tx, u, "PHARMACY_BRANCH_CREATED", {
      pharmacyId: p.id,
      branchId: branch.id,
    });
    return branch;
  });
}
// Licence and premises changes cannot inherit an earlier authenticity decision.
// Retain the file/review history, but require replacement evidence for approval.
export async function renewCredentials(u, org, input, branchId = null) {
  return prisma.$transaction(async (tx) => {
    const p = await owner(tx, u, org, { lock: true });
    const branch = branchId && p.branches.find((b) => b.id === branchId);
    if (branchId && !branch) fail("Branch not found.", 404);
    if (branch && branch.version !== input.version)
      fail("Branch changed. Refresh before updating its licence.");
    const { reason, version: expectedVersion, ...values } = input;
    const kinds = branch
      ? ["PREMISES_LICENCE"]
      : ["SUPERINTENDENT_LICENCE", "SUPERINTENDENT_APPOINTMENT"];
    const docs = latestCredentials(p.credentials, branchId).filter((d) =>
      kinds.includes(d.kind),
    );
    const updatedAt = new Date();
    for (const doc of docs) {
      await tx.pharmacyCredential.update({
        where: { id: doc.id },
        data: {
          reviewStatus: "REJECTED",
          reviewedBy: u,
          reviewedAt: updatedAt,
          sourceName: "Pharmacy metadata renewal",
          reference: "REPLACEMENT_REQUIRED",
          note: "Licence or premises details changed. Upload replacement evidence for independent review.",
        },
      });
    }
    if (branch) {
      await tx.pharmacyBranch.update({
        where: { id: branch.id },
        data: {
          ...values,
          licenceExpiresAt: new Date(values.licenceExpiresAt),
          status: "PENDING",
          version: { increment: 1 },
        },
      });
    } else {
      await tx.pharmacy.update({
        where: { id: p.id },
        data: {
          registrationDetails: { ...p.registrationDetails, ...values },
          superintendentLicenceExpiresAt: new Date(
            values.superintendentLicenceExpiresAt,
          ),
        },
      });
    }
    await tx.pharmacy.update({
      where: { id: p.id },
      data: {
        applicationSubmittedAt: null,
        complianceStatus: "PENDING",
      },
    });
    await audit(tx, u, "PHARMACY_LICENCE_DETAILS_UPDATED", {
      pharmacyId: p.id,
      branchId,
      reason,
      values,
      expectedVersion: expectedVersion ?? null,
      prior: branch || p.registrationDetails,
      priorReviews: docs.map((d) => ({
        id: d.id,
        reviewStatus: d.reviewStatus,
        reviewedBy: d.reviewedBy,
        reviewedAt: d.reviewedAt,
      })),
    });
    return { replacementRequired: true };
  });
}
export async function upload(u, org, kind, branchId, bytes, contentType) {
  if (!evidenceScannerConfigured())
    fail("Document screening is unavailable. Please retry later.", 503);
  if (!Buffer.isBuffer(bytes) || !bytes.length) fail("Choose a document.", 400);
  if (bytes.length > Math.min(evidenceUploadMaxBytes(), 5 * 1024 * 1024))
    fail("Document exceeds the scanner upload limit.", 413);
  const ext = {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
  }[contentType];
  if (!ext || !["PREMISES_LICENCE", ...GLOBAL_CREDENTIALS].includes(kind))
    fail("Unsupported credential or file type.", 400);
  if ((kind === "PREMISES_LICENCE") !== Boolean(branchId))
    fail("A premises licence must be attached to a branch.", 400);
  const p = await prisma.$transaction((tx) => owner(tx, u, org));
  if (branchId && !p.branches.some((b) => b.id === branchId))
    fail("Branch not found.", 404);
  const client = privateStorageClient();
  const stored = await uploadPrivateObject(client, {
    bucket: PRIVATE_BUCKETS.hospitalEvidenceQuarantine,
    path: `pharmacy-applications/${p.id}/${randomUUID()}.${ext}`,
    bytes,
    contentType,
  });
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await owner(tx, u, org, { lock: true });
      const doc = await tx.pharmacyCredential.create({
        data: {
          pharmacyId: current.id,
          branchId: branchId || null,
          kind,
          contentType,
          byteSize: bytes.length,
          sha256: hash(bytes),
          storageBucket: stored.bucket,
          storageKey: stored.path,
        },
      });
      // Replacing evidence never leaves an older verification valid.
      if (branchId)
        await tx.pharmacyBranch.update({
          where: { id: branchId },
          data: { status: "PENDING", version: { increment: 1 } },
        });
      else
        await tx.pharmacy.update({
          where: { id: p.id },
          data: { complianceStatus: "PENDING" },
        });
      await tx.pharmacy.update({
        where: { id: p.id },
        data: { applicationSubmittedAt: null },
      });
      await audit(tx, u, "PHARMACY_CREDENTIAL_UPLOADED", {
        pharmacyId: p.id,
        credentialId: doc.id,
        kind,
      });
      return credentialSafe(doc);
    });
  } catch (e) {
    await client.storage
      .from(stored.bucket)
      .remove([stored.path])
      .catch(() => {});
    throw e;
  }
}
export async function submit(u, org) {
  return prisma.$transaction(async (tx) => {
    const p = await owner(tx, u, org, { lock: true });
    if (!p.branches.length) fail("Add at least one branch before submitting.");
    const documents = latestCredentials(p.credentials);
    if (
      GLOBAL_CREDENTIALS.some((k) => !documents.some((d) => d.kind === k)) ||
      p.branches.some(
        (b) =>
          !latestCredentials(p.credentials, b.id).some(
            (d) => d.kind === "PREMISES_LICENCE",
          ),
      )
    )
      fail("Upload all required credentials before submitting.");
    if (p.applicationSubmittedAt)
      return { submittedAt: p.applicationSubmittedAt };
    const submittedAt = new Date();
    await tx.pharmacy.update({
      where: { id: p.id },
      data: { applicationSubmittedAt: submittedAt },
    });
    await audit(tx, u, "PHARMACY_APPLICATION_SUBMITTED", { pharmacyId: p.id });
    return { submittedAt };
  });
}
export const listingSelect = {
  id: true,
  inventoryItemId: true,
  category: true,
  description: true,
  productClass: true,
  nafdacNumber: true,
  status: true,
  imageHash: true,
  version: true,
  reviewNote: true,
  updatedAt: true,
};
export async function adjustStock(u, org, id, input) {
  const requestHash = hash(JSON.stringify(input));
  return prisma.$transaction(async (tx) => {
    const p = await owner(tx, u, org, { lock: true });
    await tx.$queryRaw`SELECT id FROM pharmacy_inventory_items WHERE id=${id} FOR UPDATE`;
    const item = await tx.pharmacyInventoryItem.findFirst({
      where: { id, pharmacyId: p.id },
    });
    if (!item) fail("Inventory item not found.", 404);
    const prior = await tx.pharmacyStockAdjustment.findUnique({
      where: {
        inventoryItemId_idempotencyKey: {
          inventoryItemId: id,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (prior) {
      if (prior.requestHash !== requestHash)
        fail("This stock adjustment key was used for a different request.");
      return { ...prior, idempotent: true };
    }
    if (item.availableQuantity !== input.expectedQuantity)
      fail("Stock changed. Refresh the inventory before adjusting it.");
    const balanceAfter = item.availableQuantity + input.quantityDelta;
    if (balanceAfter < 0 || balanceAfter > 1000000)
      fail("This adjustment would create an invalid stock balance.");
    await tx.pharmacyInventoryItem.update({
      where: { id },
      data: { availableQuantity: balanceAfter },
    });
    const adjustment = await tx.pharmacyStockAdjustment.create({
      data: {
        inventoryItemId: id,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        quantityDelta: input.quantityDelta,
        balanceBefore: item.availableQuantity,
        balanceAfter,
        actorId: u,
        reason: input.reason,
      },
    });
    await audit(tx, u, "PHARMACY_STOCK_ADJUSTED", {
      pharmacyId: p.id,
      inventoryItemId: id,
      adjustmentId: adjustment.id,
      quantityDelta: input.quantityDelta,
      balanceAfter,
      reason: input.reason,
    });
    return adjustment;
  });
}
export async function editListing(u, org, id, input) {
  return prisma.$transaction(async (tx) => {
    const p = await owner(tx, u, org, { lock: true });
    const listing = await tx.pharmacyListing.findFirst({
      where: { id, inventoryItem: { pharmacyId: p.id } },
      include: { inventoryItem: true },
    });
    if (!listing) fail("Listing not found.", 404);
    if (listing.version !== input.version)
      fail("This listing changed. Refresh before editing.");
    const {
      version,
      reason,
      medicationName,
      genericName,
      unitPriceMinor,
      isActive,
      batchNumber,
      expiryDate,
      ...details
    } = input;
    if (
      listing.inventoryItem.batchNumber &&
      (batchNumber !== listing.inventoryItem.batchNumber ||
        expiryDate !==
          listing.inventoryItem.expiryDate?.toISOString().slice(0, 10))
    )
      fail(
        "Batch identifiers and expiry dates cannot be changed. Create a new inventory item for a different batch.",
      );
    requireMedicineBatch(details.productClass, batchNumber, expiryDate);
    await tx.pharmacyInventoryItem.update({
      where: { id: listing.inventoryItemId },
      data: {
        medicationName,
        genericName,
        unitPriceMinor,
        isActive,
        batchNumber,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
      },
    });
    const result = await tx.pharmacyListing.update({
      where: { id },
      data: {
        ...details,
        status: "DRAFT",
        version: { increment: 1 },
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
      },
      select: listingSelect,
    });
    await audit(tx, u, "PHARMACY_LISTING_EDITED", {
      pharmacyId: p.id,
      listingId: id,
      expectedVersion: version,
      priorPriceMinor: listing.inventoryItem.unitPriceMinor,
      unitPriceMinor,
      isActive,
      reason,
    });
    return result;
  });
}
export async function withdrawListing(u, org, id, version) {
  return prisma.$transaction(async (tx) => {
    const p = await owner(tx, u, org, { lock: true });
    const updated = await tx.pharmacyListing.updateMany({
      where: { id, version, inventoryItem: { pharmacyId: p.id } },
      data: { status: "WITHDRAWN", version: { increment: 1 } },
    });
    if (!updated.count)
      fail("Listing changed or is unavailable. Refresh and retry.");
    await audit(tx, u, "PHARMACY_LISTING_WITHDRAWN", {
      pharmacyId: p.id,
      listingId: id,
    });
    return { id, status: "WITHDRAWN" };
  });
}
export async function sanitizeProductImage(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    !bytes.length ||
    bytes.length > 3 * 1024 * 1024
  )
    fail("Select a JPEG or PNG image up to 3 MB.", 413);
  try {
    const image = sharp(bytes, {
      limitInputPixels: 16_000_000,
      failOn: "warning",
      animated: false,
    });
    const metadata = await image.metadata();
    if (!["png", "jpeg"].includes(metadata.format) || metadata.pages > 1)
      fail("Use a single JPEG or PNG product image.", 415);
    const result = await image
      .rotate()
      .resize(1000, 1000, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    if (result.length > 1024 * 1024)
      fail("Compress this image before uploading.", 413);
    return result;
  } catch (e) {
    if (e.status) throw e;
    fail(
      "The image is damaged or unsupported. Choose another JPEG or PNG.",
      415,
    );
  }
}
export async function createListing(u, org, data) {
  requireMedicineBatch(data.productClass, data.batchNumber, data.expiryDate);
  return prisma.$transaction(async (tx) => {
    const p = await owner(tx, u, org, { lock: true });
    if (!p.branches.some((b) => b.id === data.branchId))
      fail("Branch not found.", 404);
    const {
      branchId,
      medicationName,
      genericName,
      batchNumber,
      expiryDate,
      availableQuantity,
      unitPriceMinor,
      ...listing
    } = data;
    const item = await tx.pharmacyInventoryItem.create({
      data: {
        pharmacyId: p.id,
        branchId,
        medicationName,
        genericName,
        batchNumber,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
        availableQuantity,
        unitPriceMinor,
        currency: "NGN",
        listing: { create: listing },
      },
      select: { id: true, listing: { select: listingSelect } },
    });
    await audit(tx, u, "PHARMACY_LISTING_CREATED", {
      pharmacyId: p.id,
      listingId: item.listing.id,
    });
    return item.listing;
  });
}
function requireMedicineBatch(productClass, batchNumber, expiryDate) {
  if (
    productClass !== "NON_MEDICINAL" &&
    (!batchNumber ||
      !expiryDate ||
      !Number.isFinite(new Date(expiryDate).getTime()) ||
      new Date(expiryDate) <= new Date())
  )
    fail("Medicines require a batch number and a future expiry date.", 400);
}
export async function listingImage(u, org, id, bytes) {
  const sanitized = await sanitizeProductImage(bytes);
  return prisma.$transaction(async (tx) => {
    const p = await owner(tx, u, org, { lock: true });
    const listing = await tx.pharmacyListing.findFirst({
      where: { id, inventoryItem: { pharmacyId: p.id } },
      select: { id: true },
    });
    if (!listing) fail("Listing not found.", 404);
    const updated = await tx.pharmacyListing.update({
      where: { id },
      data: {
        imageBytes: sanitized,
        imageHash: hash(sanitized),
        status: "DRAFT",
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
        version: { increment: 1 },
      },
      select: listingSelect,
    });
    await audit(tx, u, "PHARMACY_PRODUCT_IMAGE_UPDATED", {
      pharmacyId: p.id,
      listingId: id,
    });
    return updated;
  });
}
export async function submitListing(u, org, id, version) {
  return prisma.$transaction(async (tx) => {
    const p = await owner(tx, u, org, { lock: true });
    const listing = await tx.pharmacyListing.findFirst({
      where: { id, version, inventoryItem: { pharmacyId: p.id } },
      select: { ...listingSelect, inventoryItem: { select: { branch: true } } },
    });
    if (!listing) fail("Listing changed or is unavailable. Refresh and retry.");
    if (!listing.imageHash)
      fail("A product image is required before marketplace submission.");
    if (listing.productClass === "PRESCRIPTION_ONLY")
      fail(
        "Prescription-only medicines are fulfilled from issued prescriptions, not public promotional listings.",
      );
    if (
      p.complianceStatus !== "VERIFIED" ||
      !p.tier?.enabled ||
      listing.inventoryItem.branch?.status !== "VERIFIED"
    )
      fail("A verified pharmacy, branch and enabled tier are required.");
    if (new Date(listing.inventoryItem.branch.licenceExpiresAt) <= new Date())
      fail("The premises licence has expired.");
    if (listing.productClass === "OTC" && !listing.nafdacNumber)
      fail("A NAFDAC registration number is required for this medicine.");
    if (!["DRAFT", "REJECTED", "WITHDRAWN"].includes(listing.status))
      fail("The listing is already submitted or published.");
    const updated = await tx.pharmacyListing.update({
      where: { id },
      data: { status: "SUBMITTED", version: { increment: 1 } },
      select: listingSelect,
    });
    await audit(tx, u, "PHARMACY_LISTING_SUBMITTED", {
      pharmacyId: p.id,
      listingId: id,
    });
    return updated;
  });
}
export const publicWhere = () => ({
  status: "PUBLISHED",
  imageHash: { not: null },
  OR: [
    { productClass: "NON_MEDICINAL" },
    {
      productClass: "OTC",
      inventoryItem: {
        expiryDate: { gt: new Date() },
        batchNumber: { not: null },
      },
    },
  ],
  inventoryItem: {
    isActive: true,
    availableQuantity: { gt: 0 },
    branch: { status: "VERIFIED", licenceExpiresAt: { gt: new Date() } },
    pharmacy: {
      complianceStatus: "VERIFIED",
      superintendentLicenceExpiresAt: { gt: new Date() },
      tier: { enabled: true },
      admin: { accountStatus: "ACTIVE", emailVerifiedAt: { not: null } },
    },
  },
});
export async function marketplace(query) {
  const rows = await prisma.pharmacyListing.findMany({
    where: {
      ...publicWhere(),
      ...(query.pharmacyId
        ? {
            inventoryItem: {
              ...publicWhere().inventoryItem,
              pharmacyId: query.pharmacyId,
            },
          }
        : {}),
    },
    select: {
      id: true,
      category: true,
      description: true,
      productClass: true,
      nafdacNumber: true,
      inventoryItem: {
        select: {
          id: true,
          medicationName: true,
          genericName: true,
          availableQuantity: true,
          unitPriceMinor: true,
          pharmacy: {
            select: {
              id: true,
              name: true,
              address: true,
              city: true,
              state: true,
              tier: {
                select: {
                  level: true,
                  name: true,
                  deliveryEnabled: true,
                  pickupEnabled: true,
                  deliveryRadiusKm: true,
                  minimumOrderMinor: true,
                },
              },
            },
          },
          branch: {
            select: {
              id: true,
              name: true,
              address: true,
              latitude: true,
              longitude: true,
            },
          },
        },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 101,
    skip: (query.page - 1) * 100,
  });
  return {
    items: rows
      .slice(0, 100)
      .filter(
        (row) =>
          query.latitude === undefined ||
          distanceKm(row.inventoryItem.branch, query) <=
            row.inventoryItem.pharmacy.tier.deliveryRadiusKm,
      )
      .map((row) => ({
        ...row,
        imageUrl: `/api/v1/marketplace/products/${row.id}/image`,
      })),
    nextPage: rows.length > 100 ? query.page + 1 : null,
  };
}
export async function previewCredential(id, docId, u) {
  const p = await prisma.pharmacy.findUnique({
    where: { id },
    include: pharmacyInclude,
  });
  if (!p) fail("Pharmacy not found.", 404);
  if (p.adminUserId === u) fail("You cannot review your own application.", 403);
  const doc = p.credentials.find((d) => d.id === docId);
  if (!clean(doc))
    fail("Preview is available after this document passes malware screening.");
  const client = privateStorageClient();
  await assertPrivateBucket(client, doc.storageBucket);
  const result = await client.storage
    .from(doc.storageBucket)
    .createSignedUrl(doc.storageKey, 60);
  if (result.error || !result.data?.signedUrl)
    fail("Preview is temporarily unavailable.", 503);
  await audit(prisma, u, "PHARMACY_CREDENTIAL_PREVIEW_ISSUED", {
    pharmacyId: id,
    credentialId: docId,
  });
  return { url: result.data.signedUrl, expiresInSeconds: 60 };
}
