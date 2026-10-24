import crypto from "crypto";
import * as repository from "./medical-documents.repository.js";
import {
  DOCUMENT_CONTENT_TYPES,
  createDocumentStorage,
  getUploadMaxBytes,
} from "./medical-documents.storage.js";
import { buildEmergencySummaryPdf } from "./medical-documents.pdf.js";
import { signedClinicalDocument, intakeConfigured } from './medical-documents.intake.js';
import { privateStorageBackend } from '../../config/privateStorage.js';
import { wakeBackgroundJob } from '../../runtime/cloud-tasks.js';

const error = (code, status = 400) =>
  Object.assign(new Error(code), { code, status });
const storage = () => createDocumentStorage();
const key = () => `quarantine/${crypto.randomUUID()}`;

export const initializeUpload = async (ownerPatientId, data) => {
  const adapter = storage();
  if (adapter.backend === 'gcs' && !intakeConfigured()) throw error('DOCUMENT_INTAKE_UNAVAILABLE', 503);
  const document = await repository.transaction(async (tx) => {
    if (!(await repository.isPatient(tx, ownerPatientId)))
      throw error("RESOURCE_NOT_FOUND", 404);
    if (
      data.medicalRecordId &&
      !(await repository.ownedRecord(tx, ownerPatientId, data.medicalRecordId))
    )
      throw error("RESOURCE_NOT_FOUND", 404);
    const item = await repository.create(tx, {
      ownerPatientId,
      objectKey: adapter.backend === 'gcs' ? `${key()}.${{ 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }[data.contentType]}` : key(),
      ...(adapter.backend === 'gcs' ? { uploadBackend: 'gcs' } : {}),
      originalFilename: data.filename,
      declaredContentType: data.contentType,
      byteSize: data.byteSize,
      kind: data.kind,
      medicalRecordId: data.medicalRecordId,
    });
    await repository.audit(
      tx,
      ownerPatientId,
      "DOCUMENT_UPLOAD_INITIALIZED",
      item.id,
    );
    return item;
  });
  try {
    const upload = await adapter.createUpload({
      objectKey: document.objectKey,
      contentType: document.declaredContentType,
      byteSize: document.byteSize,
    });
    return { document: stripInternal(document), upload };
  } catch (cause) {
    throw error(
      cause.code === "DOCUMENT_STORAGE_UNAVAILABLE"
        ? cause.code
        : "DOCUMENT_STORAGE_ERROR",
      503,
    );
  }
};

const stripInternal = (item) => {
  const safe = { ...item };
  delete safe.objectKey;
  delete safe.ownerPatientId;
  delete safe.uploadBackend;
  return safe;
};
export const list = repository.listOwned;
export const detail = async (userId, id) => {
  const item = await repository.owned(repository.prisma, userId, id);
  if (!item) throw error("RESOURCE_NOT_FOUND", 404);
  return stripInternal(item);
};

export const completeUpload = async (userId, id) => {
  const item = await repository.owned(repository.prisma, userId, id);
  if (!item) throw error("RESOURCE_NOT_FOUND", 404);
  if (item.status !== "PENDING_UPLOAD")
    throw error("INVALID_DOCUMENT_STATE", 409);
  const adapter = storage();
  if ((item.uploadBackend === 'gcs') !== (adapter.backend === 'gcs')) throw error('DOCUMENT_STORAGE_UNAVAILABLE', 503);
  if (adapter.backend === 'gcs' && !intakeConfigured()) throw error('DOCUMENT_INTAKE_UNAVAILABLE', 503);
  let object;
  try {
    object = await adapter.head(item.objectKey);
  } catch {
    throw error("UPLOAD_OBJECT_INVALID", 409);
  }
  if (
    object.byteSize !== item.byteSize ||
    object.byteSize > getUploadMaxBytes() ||
    object.contentType !== item.declaredContentType ||
    !DOCUMENT_CONTENT_TYPES.includes(object.contentType)
    || (adapter.backend === 'gcs' && !/^[a-f0-9]{64}$/.test(object.sha256 || ''))
  )
    throw error("UPLOAD_OBJECT_INVALID", 409);
  const completed = await repository.transaction(async (tx) => {
    const result = await repository.updateState(
      tx,
      id,
      userId,
      "PENDING_UPLOAD",
      { status: "PENDING_SCAN", scanRequestedAt: new Date(), ...(adapter.backend === 'gcs' ? { sha256: object.sha256 } : {}) },
    );
    if (!result.count) throw error("INVALID_DOCUMENT_STATE", 409);
    await repository.audit(tx, userId, "DOCUMENT_UPLOAD_COMPLETED", id);
    return { id, status: "PENDING_SCAN" };
  });
  if (adapter.backend === 'gcs') await wakeBackgroundJob('patient-screening', id);
  return completed;
};

const authorizeDownload = async (userId, id, shareId) => {
  const now = new Date();
  const item = shareId
    ? await repository.prisma.medicalDocumentShare
        .findFirst({
          where: {
            id: shareId,
            recipientId: userId,
            revokedAt: null,
            expiresAt: { gt: now },
            document: { id, status: "CLEAN", deletedAt: null },
          },
          select: { document: { select: repository.internalDocumentSelect } },
        })
        .then((x) => x?.document)
    : await repository.prisma.medicalDocument.findFirst({
        where: { id, ownerPatientId: userId, status: "CLEAN", deletedAt: null },
        select: repository.internalDocumentSelect,
      });
  if (!item) throw error("RESOURCE_NOT_FOUND", 404);
  if (shareId && !(await repository.recipientEligible(repository.prisma, item.ownerPatientId, userId))) throw error('RESOURCE_NOT_FOUND', 404);
  await repository.transaction((tx) =>
    repository.audit(
      tx,
      userId,
      "DOCUMENT_DOWNLOAD_AUTHORIZED",
      item.id,
      shareId,
    ),
  );
  try {
    return item.uploadBackend === privateStorageBackend() ? await signedClinicalDocument(item) : await storage().createDownload(item.objectKey);
  } catch (cause) {
    throw error(
      cause.code === "DOCUMENT_STORAGE_UNAVAILABLE"
        ? cause.code
        : "DOCUMENT_STORAGE_ERROR",
      503,
    );
  }
};
export const ownerDownload = (userId, id) => authorizeDownload(userId, id);

export const shareRecipients = async (patientId) => {
  const active = { status: 'ACTIVE', revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] };
  const [doctors, caregivers] = await Promise.all([
    repository.prisma.doctorCareRelationship.findMany({ where: { patientId, ...active, doctorProfile: { professionType: 'DOCTOR', verificationStatus: 'VERIFIED', user: { accountStatus: 'ACTIVE' } } }, select: { doctorProfile: { select: { userId: true, user: { select: { full_name: true } } } } }, take: 100 }),
    repository.prisma.careRelationship.findMany({ where: { patientId, status: 'ACTIVE', revokedAt: null, OR: [{ accessExpiresAt: null }, { accessExpiresAt: { gt: new Date() } }], permissions: { has: 'RECORDS' }, caregiver: { accountStatus: 'ACTIVE' } }, select: { caregiverId: true, caregiver: { select: { full_name: true } } }, take: 100 }),
  ]);
  return { items: [ ...doctors.map((r) => ({ id: r.doctorProfile.userId, name: r.doctorProfile.user.full_name || 'Your doctor', type: 'DOCTOR' })), ...caregivers.map((r) => ({ id: r.caregiverId, name: r.caregiver.full_name || 'Your caregiver', type: 'CAREGIVER' })) ] };
};
export const listShares = async (patientId, id) => {
  if (!(await repository.owned(repository.prisma, patientId, id))) throw error('RESOURCE_NOT_FOUND', 404);
  const rows = await repository.prisma.medicalDocumentShare.findMany({ where: { documentId: id }, select: { id: true, recipientId: true, expiresAt: true, revokedAt: true, createdAt: true, recipient: { select: { full_name: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 100 });
  return { items: rows.map((r) => ({ id: r.id, recipientId: r.recipientId, name: r.recipient.full_name || 'Shared recipient', expiresAt: r.expiresAt, revokedAt: r.revokedAt, createdAt: r.createdAt })) };
};

export const createShare = (ownerPatientId, documentId, data) =>
  repository.transaction(async (tx) => {
    const document = await repository.owned(tx, ownerPatientId, documentId);
    if (!document || document.status !== "CLEAN")
      throw error("RESOURCE_NOT_FOUND", 404);
    if (
      data.recipientId === ownerPatientId ||
      !(await repository.recipientEligible(
        tx,
        ownerPatientId,
        data.recipientId,
      ))
    )
      throw error("RESOURCE_NOT_FOUND", 404);
    const share = await tx.medicalDocumentShare.create({
      data: {
        documentId,
        recipientId: data.recipientId,
        expiresAt: new Date(data.expiresAt),
      },
      select: {
        id: true,
        documentId: true,
        recipientId: true,
        expiresAt: true,
        createdAt: true,
      },
    });
    await repository.audit(
      tx,
      ownerPatientId,
      "DOCUMENT_SHARE_GRANTED",
      documentId,
      share.id,
    );
    return share;
  });

export const sharedWithMe = async (recipientId, q) => {
  const where = {
    recipientId,
    revokedAt: null,
    expiresAt: { gt: new Date() },
    document: { status: 'CLEAN', deletedAt: null, owner: { OR: [
      { doctorCareAsPatient: { some: { status: 'ACTIVE', revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }], doctorProfile: { userId: recipientId, professionType: 'DOCTOR', verificationStatus: 'VERIFIED' } } } },
      { careRelationshipsOwned: { some: { caregiverId: recipientId, status: 'ACTIVE', revokedAt: null, permissions: { has: 'RECORDS' }, OR: [{ accessExpiresAt: null }, { accessExpiresAt: { gt: new Date() } }] } } },
    ] } },
  };
  const [items, total] = await Promise.all([
    repository.prisma.medicalDocumentShare.findMany({
      where,
      select: {
        id: true,
        expiresAt: true,
        createdAt: true,
        document: { select: repository.safeDocumentSelect },
      },
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    repository.prisma.medicalDocumentShare.count({ where }),
  ]);
  return { items, page: q.page, limit: q.limit, total };
};
export const sharedDownload = async (userId, shareId) => {
  const grant = await repository.prisma.medicalDocumentShare.findFirst({
    where: { id: shareId, recipientId: userId },
    select: { documentId: true },
  });
  if (!grant) throw error("RESOURCE_NOT_FOUND", 404);
  return authorizeDownload(userId, grant.documentId, shareId);
};

export const revokeShare = (ownerPatientId, documentId, shareId) =>
  repository.transaction(async (tx) => {
    const result = await tx.medicalDocumentShare.updateMany({
      where: {
        id: shareId,
        documentId,
        revokedAt: null,
        document: { ownerPatientId, status: { not: "DELETED" } },
      },
      data: { revokedAt: new Date() },
    });
    if (!result.count) throw error("RESOURCE_NOT_FOUND", 404);
    await repository.audit(
      tx,
      ownerPatientId,
      "DOCUMENT_SHARE_REVOKED",
      documentId,
      shareId,
    );
  });

export const remove = async (ownerPatientId, id) => {
  const objectKey = await repository.transaction(async (tx) => {
    const item = await repository.owned(tx, ownerPatientId, id);
    if (!item) throw error("RESOURCE_NOT_FOUND", 404);
    const result = await repository.updateState(
      tx,
      id,
      ownerPatientId,
      item.status,
      {
        status: "DELETED",
        deletedAt: new Date(),
        originalFilename: "[deleted]",
        declaredContentType: "application/octet-stream",
        validatedContentType: null,
        sha256: null,
        scanVerdict: null,
      },
    );
    if (!result.count) throw error("RESOURCE_NOT_FOUND", 404);
    await tx.medicalDocumentShare.updateMany({
      where: { documentId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await repository.audit(tx, ownerPatientId, "DOCUMENT_DELETED", id);
    if (item.uploadBackend === privateStorageBackend()) {
      await tx.medicalDocument.update({ where: { id }, data: { storageCleanupPending: true, cleanupObjectKeys: { push: item.objectKey } } });
      return null;
    }
    return item.objectKey;
  });
  if (!objectKey) return;
  try {
    await storage().delete(objectKey);
  } catch (cause) {
    throw error(
      cause.code === "DOCUMENT_STORAGE_UNAVAILABLE"
        ? cause.code
        : "DOCUMENT_STORAGE_ERROR",
      503,
    );
  }
};

export const recordScanResult = async (id, data, replayDigest) => {
  let deleteKey;
  const result = await repository.transaction(async (tx) => {
    if (
      await tx.medicalDocumentScanResult.findUnique({
        where: { replayDigest },
        select: { id: true },
      })
    )
      throw error("DUPLICATE_SCAN_RESULT", 409);
    const item = await repository.findScanDocument(tx, id);
    if (!item || item.status !== "PENDING_SCAN")
      throw error("RESOURCE_NOT_FOUND", 404);
    // Google/private-intake documents are verified and promoted by the leased
    // background worker. The legacy callback must not skip its integrity check.
    if (item.uploadBackend === 'gcs' || item.uploadBackend === 'supabase') throw error('INVALID_DOCUMENT_STATE', 409);
    if (data.byteSize !== item.byteSize)
      throw error("INVALID_SCAN_RESULT", 400);
    const scannerTime = new Date(data.scannerTimestamp);
    if (Math.abs(Date.now() - scannerTime.getTime()) > 5 * 60 * 1000)
      throw error("INVALID_SCAN_RESULT", 400);
    const status =
      data.verdict === "CLEAN" && item.kind === "EXTERNAL_PRESCRIPTION"
        ? "PENDING_CLINICAL_REVIEW"
        : data.verdict;
    const changed = await repository.updateState(
      tx,
      id,
      item.ownerPatientId,
      "PENDING_SCAN",
      {
        status,
        scanVerdict: data.verdict,
        validatedContentType: data.validatedContentType,
        scannedAt: scannerTime,
        sha256: data.sha256,
      },
    );
    if (!changed.count) throw error("RESOURCE_NOT_FOUND", 404);
    await tx.medicalDocumentScanResult.create({
      data: {
        documentId: id,
        replayDigest,
        verdict: data.verdict,
        validatedContentType: data.validatedContentType,
        byteSize: data.byteSize,
        sha256: data.sha256,
        scannerTimestamp: scannerTime,
      },
      select: { id: true },
    });
    if (data.verdict !== "CLEAN") {
      await tx.medicalDocumentShare.updateMany({
        where: { documentId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      deleteKey = item.objectKey;
    }
    await repository.audit(
      tx,
      item.ownerPatientId,
      "DOCUMENT_SCAN_VERDICT_RECORDED",
      id,
    );
    return { id, status };
  });
  if (deleteKey) {
    try {
      await storage().delete(deleteKey);
    } catch {
      throw error("DOCUMENT_STORAGE_ERROR", 503);
    }
  }
  return result;
};

export const emergencyPdf = async (userId) => {
  const summary = await repository.emergencySummary(userId);
  if (!summary) throw error("RESOURCE_NOT_FOUND", 404);
  return buildEmergencySummaryPdf(summary);
};
