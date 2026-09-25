import crypto from "crypto";
import * as repository from "./medical-documents.repository.js";
import {
  DOCUMENT_CONTENT_TYPES,
  createDocumentStorage,
  getUploadMaxBytes,
} from "./medical-documents.storage.js";
import { buildEmergencySummaryPdf } from "./medical-documents.pdf.js";

const error = (code, status = 400) =>
  Object.assign(new Error(code), { code, status });
const storage = () => createDocumentStorage();
const key = () => `quarantine/${crypto.randomUUID()}`;

export const initializeUpload = async (ownerPatientId, data) => {
  const adapter = storage();
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
      objectKey: key(),
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
  let object;
  try {
    object = await storage().head(item.objectKey);
  } catch {
    throw error("UPLOAD_OBJECT_INVALID", 409);
  }
  if (
    object.byteSize !== item.byteSize ||
    object.byteSize > getUploadMaxBytes() ||
    object.contentType !== item.declaredContentType ||
    !DOCUMENT_CONTENT_TYPES.includes(object.contentType)
  )
    throw error("UPLOAD_OBJECT_INVALID", 409);
  return repository.transaction(async (tx) => {
    const result = await repository.updateState(
      tx,
      id,
      userId,
      "PENDING_UPLOAD",
      { status: "PENDING_SCAN", scanRequestedAt: new Date() },
    );
    if (!result.count) throw error("INVALID_DOCUMENT_STATE", 409);
    await repository.audit(tx, userId, "DOCUMENT_UPLOAD_COMPLETED", id);
    return { id, status: "PENDING_SCAN" };
  });
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
    return await storage().createDownload(item.objectKey);
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

export const createShare = (ownerPatientId, documentId, data) =>
  repository.transaction(async (tx) => {
    const document = await repository.owned(tx, ownerPatientId, documentId);
    if (!document || document.status === "DELETED")
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
    document: { status: { not: "DELETED" }, deletedAt: null },
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
    return item.objectKey;
  });
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
