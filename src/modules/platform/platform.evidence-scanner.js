import crypto from 'node:crypto';
import net from 'node:net';
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval } from 'node:timers';
import prisma from '../../config/db.js';
import { assertPrivateBucket, PRIVATE_BUCKETS, privateStorageClient } from '../../config/privateStorage.js';
import { evidenceScannerConfigured, evidenceScannerProvider } from '../../config/evidenceScanner.js';
import { scanWithCloudmersive } from './platform.cloudmersive.js';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ATTEMPTS = 5;
const LEASE_MS = 5 * 60_000;
const allowedHost = /^(?:localhost|127\.0\.0\.1|[a-z0-9][a-z0-9-]{1,78}[a-z0-9])$/;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function clamdAddress() {
  const host = process.env.CLAMD_HOST || '';
  const port = Number(process.env.CLAMD_PORT || 3310);
  if (!allowedHost.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CLAMD_PRIVATE_ADDRESS_INVALID');
  return { host, port };
}

function clamdCommand(command, bytes = null) {
  const address = clamdAddress();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    const chunks = [];
    let length = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.setTimeout(90_000, () => finish(new Error('CLAMD_TIMEOUT')));
    socket.on('error', () => finish(new Error('CLAMD_CONNECTION_FAILED')));
    socket.on('data', (chunk) => {
      length += chunk.length;
      if (length > 2048) return finish(new Error('CLAMD_REPLY_INVALID'));
      chunks.push(chunk);
      const response = Buffer.concat(chunks);
      const end = response.indexOf(0);
      if (end !== -1) finish(null, response.subarray(0, end).toString('utf8'));
    });
    socket.on('end', () => finish(new Error('CLAMD_REPLY_INCOMPLETE')));
    socket.on('connect', () => {
      socket.write(`z${command}\0`);
      if (bytes) {
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
          const part = bytes.subarray(offset, offset + 64 * 1024);
          const size = Buffer.allocUnsafe(4);
          size.writeUInt32BE(part.length);
          socket.write(size);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4));
      }
    });
  });
}

export async function scanWithClamd(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES) throw new Error('EVIDENCE_BYTES_INVALID');
  const version = await clamdCommand('VERSION');
  if (!/^ClamAV [^\r\n\0]{1,180}$/.test(version)) throw new Error('CLAMD_VERSION_INVALID');
  const signatureDate = Date.parse(version.split('/').at(-1));
  if (!Number.isFinite(signatureDate) || signatureDate > Date.now() + 10 * 60_000 || Date.now() - signatureDate > 72 * 60 * 60_000) throw new Error('CLAMD_SIGNATURES_STALE');
  const reply = await clamdCommand('INSTREAM', bytes);
  if (reply === 'stream: OK') return { verdict: 'CLEAN', scannerVersion: version };
  const match = /^stream: ([^\r\n\0]{1,180}) FOUND$/.exec(reply);
  if (match) return { verdict: 'INFECTED', scannerVersion: version, signature: match[1] };
  throw new Error('CLAMD_SCAN_UNCERTAIN');
}

/** Every scanner takes (bytes, job); ClamAV ignores the job, Cloudmersive checks its declared format. */
export const scanEvidence = (bytes, job) => evidenceScannerProvider() === 'cloudmersive'
  ? scanWithCloudmersive(bytes, job) : scanWithClamd(bytes);
const queuedStatuses = () => evidenceScannerProvider() === 'cloudmersive' ? ['PENDING', 'UNSCANNED_EXCEPTION'] : ['PENDING'];

export async function claimEvidenceJob(db = prisma, now = new Date()) {
  const candidates = await db.platformApplicationEvidence.findMany({
    where: { scanStatus: { in: queuedStatuses() }, OR: [{ scanLeaseExpiresAt: null }, { scanLeaseExpiresAt: { lt: now } }],
      application: { status: { in: ['SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFORMATION'] } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 10,
  });
  for (const candidate of candidates) {
    const lease = crypto.randomUUID();
    const result = await db.platformApplicationEvidence.updateMany({
      where: { id: candidate.id, scanStatus: candidate.scanStatus, OR: [{ scanLeaseExpiresAt: null }, { scanLeaseExpiresAt: { lt: now } }] },
      data: { scanLeaseToken: lease, scanLeaseExpiresAt: new Date(now.getTime() + LEASE_MS), scanAttempts: { increment: 1 }, scanErrorCode: null },
    });
    if (result.count === 1) return { ...candidate, scanLeaseToken: lease, scanAttempts: candidate.scanAttempts + 1 };
  }
  return null;
}

/**
 * Failures a retry can never fix: the stored bytes or their declared type are wrong, so the
 * document itself has to be replaced. Both scan pipelines stop at once on these.
 */
export const CONTENT_SCAN_FAILURES = Object.freeze(['EVIDENCE_INTEGRITY_MISMATCH', 'EVIDENCE_QUARANTINE_MISMATCH', 'EVIDENCE_CONTENT_TYPE_INVALID', 'CLOUDMERSIVE_FILE_TOO_LARGE', 'CLOUDMERSIVE_FORMAT_MISMATCH']);

/** Operational failures (scanner, storage or lease) an operator may re-queue once the cause is fixed. */
export const RETRYABLE_SCAN_FAILURES = Object.freeze([
  'CLOUDMERSIVE_AUTH_FAILED', 'CLOUDMERSIVE_RATE_LIMITED', 'CLOUDMERSIVE_UNAVAILABLE', 'CLOUDMERSIVE_NOT_CONFIGURED', 'CLOUDMERSIVE_REPLY_INVALID',
  'CLAMD_CONNECTION_FAILED', 'CLAMD_TIMEOUT', 'CLAMD_REPLY_INVALID', 'CLAMD_REPLY_INCOMPLETE', 'CLAMD_VERSION_INVALID', 'CLAMD_SIGNATURES_STALE', 'CLAMD_SCAN_UNCERTAIN', 'CLAMD_PRIVATE_ADDRESS_INVALID',
  'EVIDENCE_SCAN_UNCERTAIN', 'EVIDENCE_SCAN_FAILED', 'EVIDENCE_DOWNLOAD_FAILED', 'EVIDENCE_CLEAN_UPLOAD_FAILED', 'SCAN_LEASE_EXHAUSTED',
]);

/** The machine-readable code for a scan failure; anything unexpected becomes EVIDENCE_SCAN_FAILED. */
export const scanFailureCode = (error) => /^[A-Z_]{4,64}$/.test(error?.message || '') ? error.message : 'EVIDENCE_SCAN_FAILED';
export const isTerminalScanFailure = (code, attempts) => attempts >= MAX_ATTEMPTS || CONTENT_SCAN_FAILURES.includes(code);
/** Exponential backoff for the next attempt, capped at 30 minutes. */
export const scanRetryAt = (attempts, now = Date.now()) => new Date(now + Math.min(30, 2 ** attempts) * 60_000);

/** Downloads a private object and proves it is byte-for-byte the document that was uploaded. */
export async function downloadVerified(client, bucket, path, { size, sha256: digest, maxBytes = MAX_BYTES }) {
  await assertPrivateBucket(client, bucket);
  const { data, error } = await client.storage.from(bucket).download(path);
  if (error || !data) throw new Error('EVIDENCE_DOWNLOAD_FAILED');
  const bytes = Buffer.from(await data.arrayBuffer());
  if (bytes.length !== size || bytes.length === 0 || bytes.length > maxBytes || sha256(bytes) !== digest) throw new Error('EVIDENCE_INTEGRITY_MISMATCH');
  return bytes;
}

/** Copies scanned-clean bytes into the clean bucket at `${keyPrefix}.<ext>`. Idempotent across crashed workers. */
export async function releaseCleanObject(client, { keyPrefix, contentType, size, sha256: digest, maxBytes = MAX_BYTES }, bytes) {
  await assertPrivateBucket(client, PRIVATE_BUCKETS.hospitalEvidenceClean);
  const extension = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }[contentType];
  if (!extension) throw new Error('EVIDENCE_CONTENT_TYPE_INVALID');
  const path = `${keyPrefix}.${extension}`;
  const bucket = PRIVATE_BUCKETS.hospitalEvidenceClean;
  const { error } = await client.storage.from(bucket).upload(path, bytes, { contentType, upsert: false, cacheControl: '0' });
  if (error) {
    // A previous worker may have crashed after writing the clean object but
    // before committing metadata. Reuse it only if its bytes match exactly.
    try { await downloadVerified(client, bucket, path, { size, sha256: digest, maxBytes }); }
    catch { throw new Error('EVIDENCE_CLEAN_UPLOAD_FAILED'); }
  }
  return { bucket, path };
}

/**
 * Deletes the quarantine copy once the clean copy is committed. Best effort: a failure leaves an
 * unreferenced private object for operators, never a reachable document.
 */
export async function removeQuarantineObject(client, bucket, key) {
  try {
    const { error } = await client.storage.from(bucket).remove([key]);
    if (error) console.error('[evidence-scanner] Quarantine cleanup requires operator follow-up.');
  } catch { console.error('[evidence-scanner] Quarantine cleanup requires operator follow-up.'); }
}

async function markScan(db, job, data, eventType, details) {
  return db.$transaction(async (tx) => {
    const changed = await tx.platformApplicationEvidence.updateMany({ where: { id: job.id, scanStatus: job.scanStatus, scanLeaseToken: job.scanLeaseToken }, data });
    if (changed.count !== 1) return false;
    await tx.platformApplicationEvidenceEvent.create({ data: { evidenceId: job.id, eventType, actorKind: evidenceScannerProvider() === 'cloudmersive' ? 'CLOUDMERSIVE_SCANNER' : 'CLAMD_SCANNER', details } });
    return true;
  });
}

export async function processEvidenceJob({ db = prisma, client = privateStorageClient(), scan = scanEvidence } = {}) {
  const job = await claimEvidenceJob(db);
  if (!job) return false;
  if (job.scanAttempts > MAX_ATTEMPTS) {
    await markScan(db, job, { scanStatus: 'FAILED', scanErrorCode: 'SCAN_LEASE_EXHAUSTED', scannedAt: new Date(), scanLeaseToken: null, scanLeaseExpiresAt: null }, 'SCAN_FAILED', { code: 'SCAN_LEASE_EXHAUSTED', attempt: job.scanAttempts });
    return true;
  }
  try {
    if (job.storageBucket !== PRIVATE_BUCKETS.hospitalEvidenceQuarantine) throw new Error('EVIDENCE_QUARANTINE_MISMATCH');
    const bytes = await downloadVerified(client, job.storageBucket, job.storageKey, { size: job.sizeBytes, sha256: job.sha256 });
    const result = await scan(bytes, job);
    if (result.verdict === 'INFECTED') {
      await markScan(db, job, { scanStatus: 'INFECTED', scannedAt: new Date(), scannerVersion: result.scannerVersion, scanLeaseToken: null, scanLeaseExpiresAt: null }, 'SCAN_INFECTED', { signature: result.signature, sha256: job.sha256 });
      return true;
    }
    if (result.verdict === 'REJECTED') {
      await markScan(db, job, { scanStatus: 'REJECTED', scannedAt: new Date(), scannerVersion: result.scannerVersion, scanErrorCode: 'UNSAFE_DOCUMENT_CONTENT', scanLeaseToken: null, scanLeaseExpiresAt: null }, 'SCAN_REJECTED', { sha256: job.sha256 });
      return true;
    }
    if (result.verdict !== 'CLEAN' || !result.scannerVersion) throw new Error('EVIDENCE_SCAN_UNCERTAIN');
    const released = await releaseCleanObject(client, { keyPrefix: `applications/${job.applicationId}/${job.id}`, contentType: job.contentType, size: job.sizeBytes, sha256: job.sha256 }, bytes);
    const committed = await markScan(db, job, { scanStatus: 'CLEAN', storageBucket: released.bucket, storageKey: released.path, scannedAt: new Date(), scannerVersion: result.scannerVersion, scanLeaseToken: null, scanLeaseExpiresAt: null }, 'SCAN_CLEAN', { sha256: job.sha256, scannerVersion: result.scannerVersion });
    if (committed) await removeQuarantineObject(client, job.storageBucket, job.storageKey);
    return true;
  } catch (error) {
    const code = scanFailureCode(error);
    const terminal = isTerminalScanFailure(code, job.scanAttempts);
    await markScan(db, job, {
      scanStatus: terminal ? 'FAILED' : 'PENDING', scanErrorCode: code, scanLeaseToken: null,
      scanLeaseExpiresAt: terminal ? null : scanRetryAt(job.scanAttempts),
      ...(terminal ? { scannedAt: new Date() } : {}),
    }, terminal ? 'SCAN_FAILED' : 'SCAN_RETRY_SCHEDULED', { code, attempt: job.scanAttempts });
    return true;
  }
}

export function createEvidencePoller({ hospital = processEvidenceJob, doctor = async () => (await import('../doctors/onboarding.scanner.js')).processDoctorCredentialJob(), report = (queue, code) => console.error(`[evidence-scanner] ${queue} poll failed (${code}); the job remains queued.`) } = {}) {
  let running = false;
  let doctorTurn = false;
  return async () => {
    if (running) return;
    running = true;
    const queue = process.env.DOCTOR_REGISTRATION_ENABLED === 'true' && doctorTurn ? 'doctor' : 'hospital';
    // Advance before awaiting: a failed hospital query must not starve all
    // doctor credentials (or vice versa) on every subsequent interval.
    doctorTurn = !doctorTurn;
    try {
      await (queue === 'doctor' ? doctor() : hospital());
    }
    catch (error) { report(queue, /^[A-Z][A-Z0-9_]{2,64}$/.test(error?.code || '') ? error.code : 'QUEUE_UNAVAILABLE'); }
    finally { running = false; }
  };
}

export function startEvidenceScanner() {
  if (!evidenceScannerConfigured()) return () => {};
  if (evidenceScannerProvider() === 'clamav') clamdAddress();
  const poll = createEvidencePoller();
  const timer = setInterval(poll, 15_000);
  timer.unref();
  void poll();
  return () => clearInterval(timer);
}
