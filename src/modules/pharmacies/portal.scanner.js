import { randomUUID } from "node:crypto";
import { setInterval, clearInterval } from "node:timers";
import prisma from "../../config/db.js";
import {
  PRIVATE_BUCKETS,
  privateStorageClient,
} from "../../config/privateStorage.js";
import { evidenceScannerConfigured } from "../../config/evidenceScanner.js";
import {
  downloadVerified,
  releaseCleanObject,
  removeQuarantineObject,
  scanEvidence,
  scanFailureCode,
  isTerminalScanFailure,
  scanRetryAt,
} from "../platform/platform.evidence-scanner.js";
import { audit } from "./portal.service.js";

// Durable database queue and compare-and-set leases: restarting the API cannot
// lose a screening job, and several API instances cannot finish the same lease.
export async function processPharmacyCredentialJob({
  db = prisma,
  client = privateStorageClient(),
  scan = scanEvidence,
} = {}) {
  const now = new Date();
  const candidates = await db.pharmacyCredential.findMany({
    where: {
      scanStatus: "PENDING",
      OR: [{ scanLeaseExpiresAt: null }, { scanLeaseExpiresAt: { lt: now } }],
    },
    include: { pharmacy: { select: { adminUserId: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 10,
  });
  for (const doc of candidates) {
    const lease = randomUUID();
    const claim = await db.pharmacyCredential.updateMany({
      where: {
        id: doc.id,
        scanStatus: "PENDING",
        OR: [{ scanLeaseExpiresAt: null }, { scanLeaseExpiresAt: { lt: now } }],
      },
      data: {
        scanLeaseToken: lease,
        scanLeaseExpiresAt: new Date(now.getTime() + 300000),
        scanAttempts: { increment: 1 },
      },
    });
    if (!claim.count) continue;
    const attempts = doc.scanAttempts + 1;
    let data;
    try {
      if (attempts > 5) throw new Error("SCAN_LEASE_EXHAUSTED");
      if (doc.storageBucket !== PRIVATE_BUCKETS.hospitalEvidenceQuarantine)
        throw new Error("EVIDENCE_QUARANTINE_MISMATCH");
      const evidence = {
        size: doc.byteSize,
        sha256: doc.sha256,
        maxBytes: 5 * 1024 * 1024,
      };
      const bytes = await downloadVerified(
        client,
        doc.storageBucket,
        doc.storageKey,
        evidence,
      );
      const result = await scan(bytes, doc);
      if (
        !["CLEAN", "INFECTED", "REJECTED"].includes(result.verdict) ||
        !result.scannerVersion
      )
        throw new Error("EVIDENCE_SCAN_UNCERTAIN");
      data = {
        scanStatus: result.verdict,
        scannerVersion: result.scannerVersion.slice(0, 250),
        scannedAt: new Date(),
        scanErrorCode:
          result.verdict === "REJECTED" ? "UNSAFE_DOCUMENT_CONTENT" : null,
      };
      if (result.verdict === "CLEAN") {
        const released = await releaseCleanObject(
          client,
          {
            keyPrefix: `pharmacy-applications/${doc.pharmacyId}/${doc.id}`,
            contentType: doc.contentType,
            ...evidence,
          },
          bytes,
        );
        data.storageBucket = released.bucket;
        data.storageKey = released.path;
      }
    } catch (e) {
      const code = scanFailureCode(e);
      const terminal = isTerminalScanFailure(code, attempts);
      data = {
        scanStatus: terminal ? "FAILED" : "PENDING",
        scanErrorCode: code,
        scanLeaseExpiresAt: terminal ? null : scanRetryAt(attempts),
      };
    }
    const committed = await db.$transaction(async (tx) => {
      const changed = await tx.pharmacyCredential.updateMany({
        where: { id: doc.id, scanStatus: "PENDING", scanLeaseToken: lease },
        data: { scanLeaseToken: null, scanLeaseExpiresAt: null, ...data },
      });
      if (changed.count)
        await audit(
          tx,
          doc.pharmacy.adminUserId,
          `PHARMACY_SCAN_${data.scanStatus}`,
          {
            actorKind: "SYSTEM_SCANNER",
            credentialId: doc.id,
            status: data.scanStatus,
            code: data.scanErrorCode || null,
          },
        );
      return changed.count === 1;
    });
    if (committed && data.scanStatus === "CLEAN")
      await removeQuarantineObject(client, doc.storageBucket, doc.storageKey);
    return true;
  }
  return false;
}
export function startPharmacyScanner() {
  if (!evidenceScannerConfigured()) return () => {};
  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      await processPharmacyCredentialJob();
    } catch {
      console.error(
        "[pharmacy-scanner] Queue unavailable; credentials remain queued.",
      );
    } finally {
      running = false;
    }
  };
  const timer = setInterval(poll, 15000);
  timer.unref();
  void poll();
  return () => clearInterval(timer);
}
