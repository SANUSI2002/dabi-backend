import { randomUUID, randomBytes, createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import bcrypt from "bcryptjs";
import prisma from "../../config/db.js";
import {
  PRIVATE_BUCKETS,
  privateStorageClient,
  privateStorageConfigured,
  uploadPrivateObject,
  signedEvidencePreview,
} from "../../config/privateStorage.js";
import {
  evidenceScannerConfigured,
  evidenceUploadMaxBytes,
} from "../../config/evidenceScanner.js";
import * as auth from "../auth/auth.model.js";
import {
  verificationEmailConfigured,
  verificationEmailAllowedFor,
  sendEmailVerificationEmail,
} from "../auth/auth.email.js";
import { configure as configurePartner } from "../delivery/delivery.repository.js";
import {
  REQUIREMENTS,
  CONSENT_VERSION,
  latestCredentials,
  cleanCredential,
  approvalBlockers,
} from "./riders.policy.js";
import { RETRYABLE_SCAN_FAILURES } from "../platform/platform.evidence-scanner.js";

export const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status });
};
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const enabled = () =>
  process.env.RIDER_REGISTRATION_ENABLED !== "false" &&
  evidenceScannerConfigured() &&
  privateStorageConfigured();
export const maxBytes = () =>
  Math.min(evidenceUploadMaxBytes(), 5 * 1024 * 1024);
export const audit = (tx, userId, type, meta) =>
  tx.activityLog.create({
    data: { userId, type, description: "Rider onboarding action", meta },
  });
const include = {
  user: {
    select: {
      id: true,
      email: true,
      accountStatus: true,
      emailVerifiedAt: true,
    },
  },
  credentials: true,
};
export const read = (db, id) =>
  db.riderApplication.findUnique({ where: { id }, include });
export async function locked(tx, id) {
  await tx.$queryRaw`SELECT id FROM rider_applications WHERE id = ${id} FOR UPDATE`;
  const app = await read(tx, id);
  if (!app) fail("Rider application not found.", 404);
  return app;
}
function owner(app, userId) {
  if (app.userId !== userId) fail("Rider application not found.", 404);
  if (app.user.accountStatus !== "ACTIVE" || !app.user.emailVerifiedAt)
    fail("Verify your email and sign in to continue.", 403);
}
function editable(app, userId) {
  owner(app, userId);
  if (
    !["DRAFT", "SUBMITTED", "CHANGES_REQUESTED", "REJECTED", "APPROVED"].includes(
      app.status,
    )
  )
    fail("This application cannot be edited. Contact Sabi support.");
}
function versioned(app, version) {
  if (app.version !== version)
    fail("This application changed. Refresh it before continuing.");
}
function facts(data) {
  return {
    fullName: data.fullName,
    phone: data.phone,
    state: data.state,
    city: data.city,
    vehicleType: data.vehicleType,
    licenceExpiresAt: new Date(data.licenceExpiresAt),
    insuranceExpiresAt: new Date(data.insuranceExpiresAt),
    consentVersion: CONSENT_VERSION,
    consentedAt: new Date(),
  };
}
export function portalOrigin() {
  const url = new URL(
    process.env.RIDER_PORTAL_URL ||
      process.env.PHARMACY_PORTAL_URL ||
      "https://pharmacy.sabihealth.org",
  );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    fail("Rider email origin is not configured.", 503);
  return url.origin;
}
export async function sendVerification(user) {
  const raw = randomBytes(32).toString("hex");
  const token = await auth.createEmailVerificationToken(
    user.id,
    digest(raw),
    new Date(Date.now() + 86400000),
  );
  const result = await sendEmailVerificationEmail({
    email: user.email,
    verificationUrl: `${portalOrigin()}/rider/verify-email/${user.id}#${raw}`,
  });
  if (result.delivered)
    await auth.revokeOtherEmailVerificationTokens(user.id, token.id);
  else await auth.revokeEmailVerificationToken(token.id);
  return result.delivered;
}
export async function register(data) {
  if (
    !enabled() ||
    !verificationEmailConfigured() ||
    !verificationEmailAllowedFor(data.email)
  )
    fail(
      "Rider registration is temporarily unavailable. Please retry later.",
      503,
    );
  portalOrigin();
  const password = await bcrypt.hash(data.password, 12);
  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      if (
        await tx.user.findFirst({
          where: { email: { equals: data.email, mode: "insensitive" } },
          select: { id: true },
        })
      )
        fail(
          "An account already exists. Sign in to apply or reset your password.",
          409,
        );
      // No delivery role, patient record or active delivery profile is created at signup.
      const user = await tx.user.create({
        data: {
          patientId: `RIDER-${randomUUID()}`,
          email: data.email,
          password,
          full_name: data.fullName,
          phone_number: data.phone,
          accountStatus: "PENDING",
        },
      });
      const app = await tx.riderApplication.create({
        data: { userId: user.id, ...facts(data) },
      });
      await audit(tx, user.id, "RIDER_APPLICATION_CREATED", {
        applicationId: app.id,
      });
      return { user, app };
    });
  } catch (e) {
    if (e.code === "P2002")
      fail(
        "An account already exists. Sign in to apply or reset your password.",
        409,
      );
    throw e;
  }
  const emailSent = await sendVerification(result.user).catch(() => false);
  return { applicationId: result.app.id, emailSent, email: result.user.email };
}
export async function resend(email) {
  const user = await auth.findUserByEmail(email.trim().toLowerCase());
  if (
    user?.accountStatus === "PENDING" &&
    !user.emailVerifiedAt &&
    (await prisma.riderApplication.findUnique({
      where: { userId: user.id },
      select: { id: true },
    }))
  ) {
    const token = await auth.latestEmailVerificationToken(user.id);
    if (!token || token.createdAt < new Date(Date.now() - 60000))
      await sendVerification(user).catch(() => false);
  }
  return { requested: true };
}
export async function verify({ uid, token }) {
  if (
    !(await prisma.riderApplication.findUnique({
      where: { userId: uid },
      select: { id: true },
    })) ||
    !(await auth.confirmEmailVerificationToken(uid, digest(token)))
  )
    fail(
      "Verification link is invalid, expired or already used. Request a new email.",
      400,
    );
  return { verified: true };
}
export async function createApplication(userId, data) {
  if (!enabled()) fail("Rider applications are temporarily unavailable.", 503);
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { accountStatus: true, emailVerifiedAt: true },
    });
    if (user?.accountStatus !== "ACTIVE" || !user.emailVerifiedAt)
      fail("Verify your email before applying.", 403);
    if (
      await tx.deliveryPartner.findUnique({
        where: { userId },
        select: { id: true },
      })
    )
      fail(
        "This account already has a delivery partner profile. Contact support.",
      );
    try {
      const app = await tx.riderApplication.create({
        data: { userId, ...facts(data) },
      });
      await audit(tx, userId, "RIDER_APPLICATION_CREATED", {
        applicationId: app.id,
      });
      return { id: app.id };
    } catch (e) {
      if (e.code === "P2002")
        fail("A rider application already exists. Open your application.");
      throw e;
    }
  });
}
export const publicCredential = (doc) => ({
  id: doc.id,
  kind: doc.kind,
  contentType: doc.contentType,
  byteSize: doc.byteSize,
  scanStatus: doc.scanStatus,
  scanErrorCode: doc.scanErrorCode,
  reviewStatus: doc.reviewStatus,
  createdAt: doc.createdAt,
  reviewedAt: doc.reviewedAt,
});
export function publicApplication(app, reviewer = false) {
  const {
    id,
    userId,
    fullName,
    phone,
    state,
    city,
    vehicleType,
    licenceExpiresAt,
    insuranceExpiresAt,
    status,
    version,
    submittedAt,
    decisionReason,
    createdAt,
    decidedAt,
  } = app;
  return {
    id,
    userId,
    fullName,
    phone,
    state,
    city,
    vehicleType,
    licenceExpiresAt,
    insuranceExpiresAt,
    status,
    version,
    submittedAt,
    decisionReason,
    createdAt,
    decidedAt,
    email: app.user.email,
    emailVerified: !!app.user.emailVerifiedAt,
    credentials: latestCredentials(app.credentials).map((doc) => ({
      ...publicCredential(doc),
      ...(reviewer
        ? {
            sourceName: doc.sourceName,
            reference: doc.reference,
            note: doc.note,
          }
        : {}),
    })),
    blockers: approvalBlockers(app),
    requirements: REQUIREMENTS,
    maxUploadBytes: maxBytes(),
  };
}
export async function me(userId) {
  const app = await prisma.riderApplication.findUnique({
    where: { userId },
    include,
  });
  if (!app) fail("No rider application yet.", 404);
  owner(app, userId);
  return publicApplication(app);
}
export async function updateDetails(userId, id, data) {
  return prisma.$transaction(async (tx) => {
    const app = await locked(tx, id);
    editable(app, userId);
    versioned(app, data.version);
    await tx.riderApplication.update({
      where: { id },
      data: {
        ...facts(data),
        status: "DRAFT",
        submittedAt: null,
        decisionReason: null,
        version: { increment: 1 },
      },
    });
    await tx.riderCredential.updateMany({
      where: { applicationId: id },
      data: {
        reviewStatus: "PENDING",
        sourceName: null,
        reference: null,
        note: null,
        reviewedAt: null,
        reviewedBy: null,
      },
    });
    await audit(tx, userId, "RIDER_APPLICATION_UPDATED", { applicationId: id });
    return { updated: true };
  });
}
export async function upload(userId, id, kind, bytes, contentType) {
  if (!enabled()) fail("Rider uploads are temporarily unavailable.", 503);
  if (!REQUIREMENTS.some((doc) => doc.kind === kind))
    fail("Invalid rider document kind.", 400);
  if (!Buffer.isBuffer(bytes) || !bytes.length)
    fail("Select a valid file.", 400);
  if (bytes.length > maxBytes()) fail("File exceeds the scanner limit.", 413);
  const extension = {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
  }[contentType];
  if (!extension) fail("Use PDF, PNG or JPEG.", 415);
  const before = await read(prisma, id);
  if (!before) fail("Rider application not found.", 404);
  editable(before, userId);
  if (before.credentials.length >= 24)
    fail("Document revision limit reached. Contact support.");
  const client = privateStorageClient();
  const stored = await uploadPrivateObject(client, {
    bucket: PRIVATE_BUCKETS.hospitalEvidenceQuarantine,
    path: `rider-applications/${id}/${randomUUID()}.${extension}`,
    bytes,
    contentType,
  });
  try {
    return await prisma.$transaction(async (tx) => {
      const app = await locked(tx, id);
      editable(app, userId);
      versioned(app, before.version);
      if (app.credentials.length >= 24)
        fail("Document revision limit reached. Contact support.");
      const doc = await tx.riderCredential.create({
        data: {
          applicationId: id,
          revision: app.version,
          kind,
          storageKey: stored.path,
          storageBucket: stored.bucket,
          contentType,
          byteSize: bytes.length,
          sha256: digest(bytes),
        },
      });
      await tx.riderApplication.update({
        where: { id },
        data: {
          status: "DRAFT",
          submittedAt: null,
          decisionReason: null,
          version: { increment: 1 },
        },
      });
      await audit(tx, userId, "RIDER_CREDENTIAL_UPLOADED", {
        applicationId: id,
        credentialId: doc.id,
        kind,
      });
      return publicCredential(doc);
    });
  } catch (e) {
    await client.storage
      .from(stored.bucket)
      .remove([stored.path])
      .catch(() => {});
    throw e;
  }
}
export async function notice(tx, app, kind, version) {
  await tx.riderMailJob.create({
    data: { applicationId: app.id, kind, version },
  });
  await tx.notification.create({
    data: {
      userId: app.userId,
      title:
        kind === "APPROVED"
          ? "Rider application approved"
          : kind === "SUBMITTED"
            ? "Rider application received"
            : "Rider application updated",
      message:
        kind === "APPROVED"
          ? "Your rider account has been activated. Sign in to view deliveries."
          : kind === "SUBMITTED"
            ? "Your documents have been received. Screening and operations review are underway."
            : "Open your rider application to view the decision.",
    },
  });
}
export async function submit(userId, id, version) {
  return prisma.$transaction(async (tx) => {
    const app = await locked(tx, id);
    editable(app, userId);
    versioned(app, version);
    if (app.status === "SUBMITTED") return { submitted: true };
    if (latestCredentials(app.credentials).length !== REQUIREMENTS.length)
      fail("Upload each required document before submitting.");
    if (
      app.licenceExpiresAt <= new Date(new Date().toISOString().slice(0, 10)) ||
      app.insuranceExpiresAt <= new Date(new Date().toISOString().slice(0, 10))
    )
      fail("Update expired licence or insurance details before submitting.");
    const next = app.version + 1;
    await tx.riderApplication.update({
      where: { id },
      data: {
        status: "SUBMITTED",
        submittedAt: new Date(),
        version: next,
        decisionReason: null,
      },
    });
    await notice(tx, app, "SUBMITTED", next);
    await audit(tx, userId, "RIDER_APPLICATION_SUBMITTED", {
      applicationId: id,
    });
    return { submitted: true };
  });
}
export async function queue(actorId, { status, offset }) {
  const rows = await prisma.riderApplication.findMany({
    where: { status },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 51,
    skip: offset,
    select: {
      id: true,
      fullName: true,
      state: true,
      city: true,
      status: true,
      submittedAt: true,
      createdAt: true,
      user: { select: { email: true } },
    },
  });
  await audit(prisma, actorId, "RIDER_REVIEW_QUEUE_VIEWED", { status, offset });
  return {
    items: rows.slice(0, 50),
    nextOffset: rows.length > 50 ? offset + 50 : null,
  };
}
export async function detail(actorId, id) {
  const app = await read(prisma, id);
  if (!app) fail("Rider application not found.", 404);
  await audit(prisma, actorId, "RIDER_APPLICATION_VIEWED", {
    applicationId: id,
  });
  return publicApplication(app, true);
}
function currentDocument(app, id) {
  const doc = latestCredentials(app.credentials).find((row) => row.id === id);
  if (!doc) fail("Current document not found.", 404);
  return doc;
}
export async function preview(actorId, id, credentialId) {
  const app = await read(prisma, id);
  if (!app) fail("Rider application not found.", 404);
  const doc = currentDocument(app, credentialId);
  if (!cleanCredential(doc))
    fail("Preview is available after clean malware screening.");
  const url = await signedEvidencePreview(privateStorageClient(), doc);
  await audit(prisma, actorId, "RIDER_CREDENTIAL_PREVIEW_ISSUED", {
    applicationId: id,
    credentialId,
  });
  return { url, expiresInSeconds: 60 };
}
export async function review(actorId, id, credentialId, data) {
  return prisma.$transaction(async (tx) => {
    const app = await locked(tx, id);
    versioned(app, data.version);
    if (app.userId === actorId)
      fail("You cannot review your own rider application.", 403);
    if (app.status !== "SUBMITTED")
      fail("Only submitted applications can be reviewed.");
    const doc = currentDocument(app, credentialId);
    if (!cleanCredential(doc))
      fail("Clean screening is required before authenticity review.");
    await tx.riderCredential.update({
      where: { id: doc.id },
      data: {
        reviewStatus: data.reviewStatus,
        sourceName: data.sourceName,
        reference: data.reference,
        note: data.note,
        reviewedAt: new Date(),
        reviewedBy: actorId,
      },
    });
    await tx.riderApplication.update({
      where: { id },
      data: { version: { increment: 1 } },
    });
    await audit(tx, actorId, "RIDER_CREDENTIAL_REVIEWED", {
      applicationId: id,
      credentialId,
      decision: data.reviewStatus,
    });
    return { reviewed: true };
  });
}
export async function decide(
  actorId,
  id,
  decision,
  { version, reason = null },
) {
  return prisma.$transaction(async (tx) => {
    const app = await locked(tx, id);
    versioned(app, version);
    if (app.userId === actorId)
      fail("You cannot decide your own rider application.", 403);
    if (
      decision === "SUSPENDED"
        ? app.status !== "APPROVED"
        : app.status !== "SUBMITTED"
    )
      fail("This application cannot receive that decision.");
    if (decision === "APPROVED") {
      const blockers = approvalBlockers(app);
      if (blockers.length) fail(blockers.join(" "));
      await configurePartner(tx, actorId, app.userId, {
        displayName: app.fullName,
        isActive: true,
      });
    } else if (decision === "SUSPENDED")
      await tx.deliveryPartner.updateMany({
        where: { userId: app.userId },
        data: { isActive: false },
      });
    const next = app.version + 1;
    await tx.riderApplication.update({
      where: { id },
      data: {
        status: decision,
        decisionReason: reason,
        decidedAt: new Date(),
        decidedBy: actorId,
        version: next,
        ...(decision === "CHANGES_REQUESTED" ? { submittedAt: null } : {}),
      },
    });
    await notice(tx, app, decision, next);
    await audit(tx, actorId, `RIDER_${decision}`, { applicationId: id });
    return { decided: true, status: decision };
  });
}
export async function retryScan(actorId, id, credentialId, version) {
  if (!enabled()) fail("Rider scanning is unavailable.", 503);
  return prisma.$transaction(async (tx) => {
    const app = await locked(tx, id);
    versioned(app, version);
    if (app.status !== "SUBMITTED")
      fail("Only submitted applications can be re-screened.");
    const doc = currentDocument(app, credentialId);
    if (
      doc.scanStatus !== "FAILED" ||
      !RETRYABLE_SCAN_FAILURES.includes(doc.scanErrorCode) ||
      doc.storageBucket !== PRIVATE_BUCKETS.hospitalEvidenceQuarantine ||
      doc.byteSize > maxBytes()
    )
      fail(
        "Replace unsafe files. Only operational scanner failures can be retried.",
      );
    await tx.riderCredential.update({
      where: { id: doc.id },
      data: {
        scanStatus: "PENDING",
        scanAttempts: 0,
        scanErrorCode: null,
        scanLeaseToken: null,
        scanLeaseExpiresAt: null,
      },
    });
    await tx.riderApplication.update({
      where: { id },
      data: { version: { increment: 1 } },
    });
    await audit(tx, actorId, "RIDER_SCAN_REQUEUED", {
      applicationId: id,
      credentialId,
    });
    return { queued: true };
  });
}
