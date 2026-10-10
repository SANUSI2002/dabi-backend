import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { setInterval, clearInterval } from "node:timers";
import prisma from "../../config/db.js";
import {
  verificationEmailConfigured,
  verificationEmailAllowedFor,
} from "../auth/auth.email.js";

const DAY = 86400000;
const RETRY_WINDOW = 23 * 60 * 60 * 1000;
export const reminderStage = (expiry, now = new Date()) => {
  if (!expiry) return null;
  const days = Math.ceil((new Date(expiry).getTime() - now.getTime()) / DAY);
  if (!Number.isFinite(days) || days > 30) return null;
  return days <= 0 ? "EXPIRED" : String([1, 7, 14, 30].find((n) => days <= n));
};
export function pharmacyAccessUrl() {
  const url = new URL(
    process.env.PHARMACY_PORTAL_URL || "https://pharmacy.sabihealth.org",
  );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("PHARMACY_EMAIL_URL_INVALID");
  return `${url.origin}/pharmacy/login`;
}

// Identical event keys collapse retries, including multiple reminder workers. Writes
// happen in the business transaction; provider requests never hold a database lock.
export async function enqueuePharmacyEmail(
  tx,
  pharmacy,
  {
    eventKey,
    kind,
    expectedStatus = null,
    branchId = null,
    licenceExpiry = null,
    subject,
    message,
  },
) {
  return tx.pharmacyEmailJob.createMany({
    data: [
      {
        id: randomUUID(),
        pharmacyId: pharmacy.id,
        eventKey,
        kind,
        recipient: pharmacy.admin.email,
        sender: process.env.PASSWORD_RESET_EMAIL_FROM?.trim() || null,
        subject,
        text: `${message}\n\nSign in to your pharmacy portal:\n${pharmacyAccessUrl()}\n\nSabi Pharmacy · support@sabihealth.org\nThis email never contains your password or a private document link.`,
        expectedStatus,
        branchId,
        licenceExpiry,
      },
    ],
    skipDuplicates: true,
  });
}
export const queueDecisionEmail = (tx, pharmacy, status, decisionId) =>
  enqueuePharmacyEmail(tx, pharmacy, {
    eventKey: `decision/${decisionId}`,
    kind: "COMPLIANCE_DECISION",
    expectedStatus: status,
    subject:
      status === "VERIFIED"
        ? "Your Sabi Pharmacy application is approved"
        : status === "REJECTED"
          ? "Update on your Sabi Pharmacy application"
          : "Your Sabi Pharmacy marketplace access is suspended",
    message:
      status === "VERIFIED"
        ? `Your pharmacy, ${pharmacy.name}, has completed Sabi's document and authenticity review and is approved. Sign in using your existing Sabi ID to manage branches and stock. Product listings require separate marketplace review; pharmacy approval is not a regulatory licence.`
        : status === "REJECTED"
          ? `Your application for ${pharmacy.name} was not approved. Sign in to view the review findings, correct the requested information and resubmit. Contact Sabi support if you need help.`
          : `Marketplace access for ${pharmacy.name} has been suspended. Sign in to view the decision and contact Sabi support. Existing order and financial history has not been deleted.`,
  });

export async function queueLicenceReminders({
  db = prisma,
  now = new Date(),
  afterId = null,
  limit = 100,
} = {}) {
  const rows = await db.pharmacy.findMany({
    where: {
      tierLevel: { not: null },
      complianceStatus: "VERIFIED",
      ...(afterId ? { id: { gt: afterId } } : {}),
      admin: { accountStatus: "ACTIVE", emailVerifiedAt: { not: null } },
    },
    orderBy: { id: "asc" },
    take: limit,
    include: { admin: { select: { email: true } }, branches: true },
  });
  let queued = 0;
  for (const p of rows) {
    const licences = [
      {
        id: null,
        name: "Superintendent pharmacist licence",
        expiry: p.superintendentLicenceExpiresAt,
      },
      ...p.branches
        .filter((b) => b.status === "VERIFIED")
        .map((b) => ({
          id: b.id,
          name: `${b.name} premises licence`,
          expiry: b.licenceExpiresAt,
        })),
    ];
    for (const licence of licences) {
      const stage = reminderStage(licence.expiry, now);
      if (!stage) continue;
      await db.$transaction(async (tx) => {
        // Serialize with renewals/decisions. A stale candidate never produces a reminder.
        await tx.$queryRaw`SELECT id FROM pharmacies WHERE id=${p.id} FOR UPDATE`;
        const current = await tx.pharmacy.findUnique({
          where: { id: p.id },
          include: { admin: true, branches: true },
        });
        const currentExpiry = licence.id
          ? current?.branches.find(
              (b) => b.id === licence.id && b.status === "VERIFIED",
            )?.licenceExpiresAt
          : current?.superintendentLicenceExpiresAt;
        if (
          current?.complianceStatus !== "VERIFIED" ||
          current.admin.accountStatus !== "ACTIVE" ||
          !current.admin.emailVerifiedAt ||
          !currentExpiry ||
          currentExpiry.getTime() !== licence.expiry.getTime()
        )
          return;
        const inserted = await enqueuePharmacyEmail(tx, current, {
          eventKey: `licence/${p.id}/${licence.id || "superintendent"}/${licence.expiry.toISOString()}/${stage}`,
          kind: "LICENCE_EXPIRY",
          expectedStatus: "VERIFIED",
          branchId: licence.id,
          licenceExpiry: licence.expiry,
          subject:
            stage === "EXPIRED"
              ? "Action required: pharmacy licence has expired"
              : `Pharmacy licence renewal reminder · within ${stage} days`,
          message: `${licence.name} for ${p.name} ${stage === "EXPIRED" ? "has expired" : `expires within ${stage} days`} (${licence.expiry.toISOString().slice(0, 10)}). Renew it with the issuing authority, then update the licence details and upload replacement evidence in Sabi Pharmacy. Expired credentials prevent eligible marketplace selling/dispensing. Sabi must review replacement evidence before renewed access is approved.`,
        });
        queued += inserted.count;
      });
    }
  }
  return {
    visited: rows.length,
    queued,
    nextCursor: rows.length === limit ? rows.at(-1).id : null,
  };
}

export async function sendPharmacyEmail(job) {
  try {
    const response = await globalThis.fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `pharmacy/${job.id}`,
      },
      body: JSON.stringify({
        from: job.sender,
        to: [job.recipient],
        subject: job.subject,
        text: job.text,
      }),
      signal: globalThis.AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok)
      return {
        sent: false,
        retryable: response.status === 429 || response.status >= 500,
        code: `PROVIDER_HTTP_${response.status}`,
      };
    const data = await response.json();
    if (typeof data.id !== "string" || !data.id)
      return {
        sent: false,
        retryable: true,
        code: "PROVIDER_UNCERTAIN_RESPONSE",
      };
    return { sent: true, providerId: data.id.slice(0, 160) };
  } catch {
    return { sent: false, retryable: true, code: "PROVIDER_REQUEST_FAILED" };
  }
}
export async function deliverPharmacyEmail({
  db = prisma,
  now = new Date(),
  send = sendPharmacyEmail,
  configured = verificationEmailConfigured,
  allowed = verificationEmailAllowedFor,
} = {}) {
  if (!configured()) return { claimed: false };
  const token = randomUUID();
  const job = await db.$transaction(async (tx) => {
    const rows =
      await tx.$queryRaw`SELECT id FROM pharmacy_email_jobs WHERE status='QUEUED' AND next_attempt_at <= ${now} AND (lease_expires_at IS NULL OR lease_expires_at < ${now}) ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!rows.length) return null;
    const candidate = await tx.pharmacyEmailJob.findUnique({
      where: { id: rows[0].id },
      include: { pharmacy: { include: { admin: true, branches: true } } },
    });
    const p = candidate.pharmacy;
    const expiry = candidate.branchId
      ? p.branches.find(
          (b) => b.id === candidate.branchId && b.status === "VERIFIED",
        )?.licenceExpiresAt
      : p.superintendentLicenceExpiresAt;
    const stale =
      p.admin.accountStatus !== "ACTIVE" ||
      !p.admin.emailVerifiedAt ||
      p.admin.email !== candidate.recipient ||
      (candidate.expectedStatus &&
        p.complianceStatus !== candidate.expectedStatus) ||
      (candidate.licenceExpiry &&
        (!expiry || expiry.getTime() !== candidate.licenceExpiry.getTime())) ||
      (candidate.kind === "LICENCE_EXPIRY" &&
        reminderStage(expiry, now) !== candidate.eventKey.split("/").at(-1));
    const windowExpired =
      candidate.firstAttemptAt &&
      now - candidate.firstAttemptAt >= RETRY_WINDOW;
    if (
      stale ||
      windowExpired ||
      candidate.attempts >= 6 ||
      !allowed(candidate.recipient)
    ) {
      await tx.pharmacyEmailJob.update({
        where: { id: candidate.id },
        data: {
          status: stale ? "CANCELLED" : "FAILED",
          lastErrorCode: stale
            ? "EVENT_SUPERSEDED"
            : windowExpired
              ? "RETRY_WINDOW_EXPIRED"
              : !allowed(candidate.recipient)
                ? "RECIPIENT_NOT_ALLOWED"
                : "ATTEMPTS_EXHAUSTED",
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      return null;
    }
    return tx.pharmacyEmailJob.update({
      where: { id: candidate.id },
      data: {
        sender: candidate.sender || process.env.PASSWORD_RESET_EMAIL_FROM,
        attempts: { increment: 1 },
        firstAttemptAt: candidate.firstAttemptAt || now,
        leaseToken: token,
        leaseExpiresAt: new Date(now.getTime() + 60000),
      },
    });
  });
  if (!job) return { claimed: false };
  const result = await send(job);
  const retry = !result.sent && result.retryable && job.attempts < 6;
  const changed = await db.pharmacyEmailJob.updateMany({
    where: { id: job.id, status: "QUEUED", leaseToken: token },
    data: {
      status: result.sent ? "SENT" : retry ? "QUEUED" : "FAILED",
      providerId: result.sent ? result.providerId : null,
      sentAt: result.sent ? now : null,
      lastErrorCode: result.sent ? null : result.code,
      nextAttemptAt: new Date(
        now.getTime() + Math.min(60000 * 2 ** (job.attempts - 1), 1800000),
      ),
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  return { claimed: true, sent: Boolean(result.sent && changed.count) };
}

export function startPharmacyMailWorker() {
  if (process.env.PHARMACY_EMAIL_WORKER === "false") return () => {};
  let running = false,
    cursor = null,
    reminderAt = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (Date.now() >= reminderAt) {
        const result = await queueLicenceReminders({ afterId: cursor });
        cursor = result.nextCursor;
        reminderAt = Date.now() + (cursor ? 60000 : 60 * 60 * 1000);
      }
      // Bound sending rate: at most one email per tick per API process.
      await deliverPharmacyEmail();
    } catch {
      console.error(
        "[pharmacy-mail] Queue tick failed; persisted jobs remain available.",
      );
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 15000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
