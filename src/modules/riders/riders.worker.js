import { randomUUID } from "node:crypto";
import { setInterval, clearInterval } from "node:timers";
import prisma from "../../config/db.js";
import {
  privateStorageClient,
  PRIVATE_BUCKETS,
} from "../../config/privateStorage.js";
import {
  downloadVerified,
  releaseCleanObject,
  removeQuarantineObject,
  scanEvidence,
  scanFailureCode,
  isTerminalScanFailure,
  scanRetryAt,
} from "../platform/platform.evidence-scanner.js";
import {
  verificationEmailConfigured,
  verificationEmailAllowedFor,
} from "../auth/auth.email.js";
import { enabled, maxBytes, audit, portalOrigin } from "./riders.service.js";

export async function processRiderCredentialJob({
  db = prisma,
  client,
  scan = scanEvidence,
} = {}) {
  if (!enabled()) return false;
  client ||= privateStorageClient();
  const now = new Date();
  const rows = await db.riderCredential.findMany({
    where: {
      scanStatus: "PENDING",
      OR: [{ scanLeaseExpiresAt: null }, { scanLeaseExpiresAt: { lt: now } }],
    },
    include: { application: { select: { userId: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 10,
  });
  for (const doc of rows) {
    const lease = randomUUID();
    const claimed = await db.riderCredential.updateMany({
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
    if (!claimed.count) continue;
    let data;
    try {
      if (doc.scanAttempts >= 5) throw new Error("SCAN_LEASE_EXHAUSTED");
      if (doc.storageBucket !== PRIVATE_BUCKETS.hospitalEvidenceQuarantine)
        throw new Error("EVIDENCE_QUARANTINE_MISMATCH");
      const evidence = {
        size: doc.byteSize,
        sha256: doc.sha256,
        maxBytes: maxBytes(),
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
        typeof result.scannerVersion !== "string" ||
        !result.scannerVersion.trim()
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
            keyPrefix: `rider-applications/${doc.applicationId}/${doc.id}`,
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
      const terminal = isTerminalScanFailure(code, doc.scanAttempts + 1);
      data = {
        scanStatus: terminal ? "FAILED" : "PENDING",
        scanErrorCode: code,
        scanLeaseExpiresAt: terminal ? null : scanRetryAt(doc.scanAttempts + 1),
      };
    }
    const committed = await db.$transaction(async (tx) => {
      const result = await tx.riderCredential.updateMany({
        where: { id: doc.id, scanStatus: "PENDING", scanLeaseToken: lease },
        data: { scanLeaseToken: null, scanLeaseExpiresAt: null, ...data },
      });
      if (result.count)
        await audit(
          tx,
          doc.application.userId,
          `RIDER_SCAN_${data.scanStatus}`,
          {
            actorKind: "SYSTEM_SCANNER",
            credentialId: doc.id,
            code: data.scanErrorCode || null,
          },
        );
      return result.count === 1;
    });
    if (committed && data.scanStatus === "CLEAN")
      await removeQuarantineObject(client, doc.storageBucket, doc.storageKey);
    return true;
  }
  return false;
}
export async function sendRiderEmail(job) {
  const labels = {
    SUBMITTED: "We received your Sabi rider application",
    APPROVED: "Your Sabi rider application is approved",
    CHANGES_REQUESTED: "Your Sabi rider application needs changes",
    REJECTED: "Your Sabi rider application has been reviewed",
    SUSPENDED: "Your Sabi rider access has been suspended",
  };
  const link = `${portalOrigin()}/rider/${job.kind === "APPROVED" ? "login" : "application"}`;
  const body =
    job.kind === "APPROVED"
      ? "Sabi operations has reviewed your documents and approved your rider account. Sign in using your existing Sabi email and password. No password is sent by email."
      : job.kind === "SUBMITTED"
        ? "Your documents have been received. Malware screening and operations review will run in the background. You can check your application status at any time."
        : "Open your application to view the decision and any requested changes.";
  try {
    const response = await globalThis.fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `sabi-rider-${job.id}`,
      },
      body: JSON.stringify({
        from: process.env.PASSWORD_RESET_EMAIL_FROM,
        to: [job.application.user.email],
        subject: labels[job.kind],
        text: `${body}\n\n${link}\n\nFor help: support@sabihealth.org`,
      }),
      signal: globalThis.AbortSignal.timeout(10000),
    });
    return {
      sent: response.ok,
      retryable: response.status === 429 || response.status >= 500,
    };
  } catch {
    return { sent: false, retryable: true };
  }
}
export async function processRiderEmailJob({
  db = prisma,
  send = sendRiderEmail,
  now = new Date(),
  configured = verificationEmailConfigured,
  allowed = verificationEmailAllowedFor,
} = {}) {
  if (!configured()) return false;
  const lease = randomUUID();
  const job = await db.$transaction(async (tx) => {
    const rows =
      await tx.$queryRaw`SELECT id FROM rider_mail_jobs WHERE status='PENDING' AND "nextAttemptAt" <= ${now} AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < ${now}) ORDER BY "nextAttemptAt",id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!rows.length) return null;
    const candidate = await tx.riderMailJob.findUnique({
      where: { id: rows[0].id },
      include: {
        application: {
          include: {
            user: {
              select: {
                email: true,
                accountStatus: true,
                emailVerifiedAt: true,
              },
            },
          },
        },
      },
    });
    const stale =
      candidate.application.status !== candidate.kind ||
      candidate.application.user.accountStatus !== "ACTIVE" ||
      !candidate.application.user.emailVerifiedAt;
    if (
      stale ||
      candidate.attempts >= 6 ||
      now - candidate.createdAt >= 23 * 3600000 ||
      !allowed(candidate.application.user.email)
    ) {
      await tx.riderMailJob.update({
        where: { id: candidate.id },
        data: {
          status: stale ? "CANCELLED" : "FAILED",
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      return null;
    }
    return tx.riderMailJob.update({
      where: { id: candidate.id },
      data: {
        attempts: { increment: 1 },
        leaseToken: lease,
        leaseExpiresAt: new Date(now.getTime() + 60000),
      },
      include: {
        application: { include: { user: { select: { email: true } } } },
      },
    });
  });
  if (!job) return false;
  let result;
  try {
    result = await send(job);
  } catch {
    result = { sent: false, retryable: true };
  }
  await db.riderMailJob.updateMany({
    where: { id: job.id, status: "PENDING", leaseToken: lease },
    data: {
      status: result.sent
        ? "SENT"
        : result.retryable && job.attempts < 6
          ? "PENDING"
          : "FAILED",
      sentAt: result.sent ? new Date() : null,
      nextAttemptAt: new Date(
        now.getTime() + Math.min(30, 2 ** job.attempts) * 60000,
      ),
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  return true;
}
export function startRiderWorker() {
  if (process.env.RIDER_WORKER_ENABLED === "false") return () => {};
  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      const results = await Promise.allSettled([
        processRiderCredentialJob(),
        processRiderEmailJob(),
      ]);
      if (results.some((row) => row.status === "rejected"))
        console.error("[rider-worker] Queue unavailable; work remains queued.");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(poll, 15000);
  timer.unref();
  void poll();
  return () => clearInterval(timer);
}
