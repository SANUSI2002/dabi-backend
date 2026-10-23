// Emails to a hospital's customers (payment reminders, statements of account), sent through Resend.
//
// A notice is recorded and its email queued in the same transaction; a worker sends queued emails
// (never holding a database lock while calling the provider) and retries a provider outage with a
// growing wait, up to five tries. The email comes from the hospital's name at Sabi's sending address,
// with replies going to the staff member who sent it. Without an email provider configured, or when the
// customer has no email address, the notice is still recorded and says it was not emailed.
import { randomUUID } from 'node:crypto';
import { setInterval, clearInterval } from 'node:timers';
import prisma from '../../../config/db.js';
import { passwordResetEmailAllowedFor, passwordResetEmailConfigured } from '../../auth/auth.email.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const WORKER = 'finance-email-worker';
export const emailConfigured = passwordResetEmailConfigured;

/** Who an email is from: read before the tenant transaction (the EMR role cannot read emails). */
export async function senderFor(context, db = prisma) {
  const [user, facility] = await Promise.all([
    db.user.findUnique({ where: { id: context.userId }, select: { email: true, full_name: true } }),
    context.facilityId ? db.organisation.findUnique({ where: { id: context.facilityId }, select: { name: true } }) : null,
  ]);
  return { replyTo: user?.email ?? null, staffName: user?.full_name ?? null, hospitalName: facility?.name ?? 'Your hospital' };
}

const clean = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
/** Queues the email for a recorded notice (inside its transaction); says why when it cannot be sent. */
export async function queueCustomerEmail(tx, context, { noticeId, recipient, subject, body, sender, hospitalName }) {
  if (!recipient) return { status: 'NOT_SENT', reason: 'NO_EMAIL_ADDRESS' };
  if (!emailConfigured() || !passwordResetEmailAllowedFor(recipient)) return { status: 'NOT_SENT', reason: 'EMAIL_NOT_CONFIGURED' };
  const name = clean(hospitalName || sender.hospitalName).slice(0, 120);
  const signature = [`${name} — accounts`, sender.staffName ? `Sent by ${clean(sender.staffName)}` : null, sender.replyTo ? 'Reply to this email to reach our accounts team.' : null].filter(Boolean).join('\n');
  await tx.acctEmailJob.create({
    data: {
      id: randomUUID(), organizationId: context.organizationId, noticeId, recipient: recipient.slice(0, 160), replyTo: sender.replyTo?.slice(0, 160) ?? null,
      fromName: name, subject: clean(subject).slice(0, 300), body: `${body}\n\n${signature}`.slice(0, 20000),
    },
  });
  return { status: 'QUEUED' };
}

async function withWorker(work, db = prisma) {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE sabi_emr_app');
    await tx.$executeRaw`SELECT set_config('app.system_context', ${WORKER}, true)`;
    return work(tx);
  }, { maxWait: 5000, timeout: 15000 });
}

const retryAt = (attempts, now) => new Date(now.getTime() + Math.min(60, 2 ** attempts) * 60_000);
export async function sendCustomerEmail(job, fetcher = globalThis.fetch) {
  const from = process.env.PASSWORD_RESET_EMAIL_FROM.trim();
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const response = await fetcher(RESEND_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': job.id },
    body: JSON.stringify({ from: `${job.fromName.replace(/[<>"]/g, '')} <${address}>`, to: [job.recipient], subject: job.subject, text: job.body, ...(job.replyTo ? { reply_to: job.replyTo } : {}) }),
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  if (!response.ok) return { ok: false, retryable: response.status === 429 || response.status >= 500, code: `PROVIDER_HTTP_${response.status}` };
  const body = await response.json().catch(() => ({}));
  return { ok: true, providerId: typeof body.id === 'string' ? body.id.slice(0, 120) : null };
}

/** Sends queued customer emails, a few at a time, across organizations. */
export async function deliverCustomerEmails({ now = new Date(), send = sendCustomerEmail, configured = emailConfigured } = {}) {
  if (!configured()) return 0;
  const due = await withWorker((tx) => tx.acctEmailJob.findMany({ where: { status: 'QUEUED', nextAttemptAt: { lte: now } }, orderBy: { createdAt: 'asc' }, take: 20 }));
  let sent = 0;
  for (const job of due) {
    // claim it: the next try is pushed out first, so a second worker skips it
    const claimed = await withWorker((tx) => tx.acctEmailJob.updateMany({ where: { id: job.id, status: 'QUEUED', attempts: job.attempts }, data: { attempts: { increment: 1 }, nextAttemptAt: retryAt(job.attempts + 1, now) } }));
    if (!claimed.count) continue;
    let result;
    try { result = await send(job); } catch { result = { ok: false, retryable: true, code: 'PROVIDER_UNREACHABLE' }; }
    const finished = result.ok || !result.retryable || job.attempts + 1 >= 5;
    await withWorker((tx) => tx.acctEmailJob.updateMany({
      where: { id: job.id },
      data: result.ok ? { status: 'SENT', sentAt: new Date(), providerMessageId: result.providerId, lastError: null } : { lastError: result.code, ...(finished ? { status: 'FAILED' } : {}) },
    }));
    if (result.ok) sent += 1;
  }
  return sent;
}

export function startCustomerEmailWorker() {
  if (process.env.FINANCE_EMAIL_WORKER_ENABLED === 'false') return () => {};
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || !emailConfigured()) return;
    busy = true;
    try { await deliverCustomerEmails(); } catch { console.error('[finance-email] Sending unavailable; emails stay queued.'); } finally { busy = false; }
  }, 20000);
  timer.unref?.();
  return () => clearInterval(timer);
}
