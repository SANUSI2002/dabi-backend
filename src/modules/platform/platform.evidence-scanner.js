import crypto from 'node:crypto';
import net from 'node:net';
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval } from 'node:timers';
import prisma from '../../config/db.js';
import { assertPrivateBucket, PRIVATE_BUCKETS, privateStorageClient } from '../../config/privateStorage.js';

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

export async function claimEvidenceJob(db = prisma, now = new Date()) {
  const candidates = await db.platformApplicationEvidence.findMany({
    where: { scanStatus: 'PENDING', OR: [{ scanLeaseExpiresAt: null }, { scanLeaseExpiresAt: { lt: now } }],
      application: { status: { in: ['SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFORMATION'] } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 10,
  });
  for (const candidate of candidates) {
    const lease = crypto.randomUUID();
    const result = await db.platformApplicationEvidence.updateMany({
      where: { id: candidate.id, scanStatus: 'PENDING', OR: [{ scanLeaseExpiresAt: null }, { scanLeaseExpiresAt: { lt: now } }] },
      data: { scanLeaseToken: lease, scanLeaseExpiresAt: new Date(now.getTime() + LEASE_MS), scanAttempts: { increment: 1 }, scanErrorCode: null },
    });
    if (result.count === 1) return { ...candidate, scanLeaseToken: lease, scanAttempts: candidate.scanAttempts + 1 };
  }
  return null;
}

async function downloadVerified(client, bucket, path, evidence) {
  await assertPrivateBucket(client, bucket);
  const { data, error } = await client.storage.from(bucket).download(path);
  if (error || !data) throw new Error('EVIDENCE_DOWNLOAD_FAILED');
  const bytes = Buffer.from(await data.arrayBuffer());
  if (bytes.length !== evidence.sizeBytes || bytes.length === 0 || bytes.length > MAX_BYTES || sha256(bytes) !== evidence.sha256) throw new Error('EVIDENCE_INTEGRITY_MISMATCH');
  return bytes;
}

async function releaseCleanObject(client, job, bytes) {
  await assertPrivateBucket(client, PRIVATE_BUCKETS.hospitalEvidenceClean);
  const extension = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }[job.contentType];
  if (!extension) throw new Error('EVIDENCE_CONTENT_TYPE_INVALID');
  const path = `applications/${job.applicationId}/${job.id}.${extension}`;
  const bucket = PRIVATE_BUCKETS.hospitalEvidenceClean;
  const { error } = await client.storage.from(bucket).upload(path, bytes, { contentType: job.contentType, upsert: false, cacheControl: '0' });
  if (error) {
    // A previous worker may have crashed after writing the clean object but
    // before committing metadata. Reuse it only if its bytes match exactly.
    await downloadVerified(client, bucket, path, job);
  }
  return { bucket, path };
}

async function markScan(db, job, data, eventType, details) {
  return db.$transaction(async (tx) => {
    const changed = await tx.platformApplicationEvidence.updateMany({ where: { id: job.id, scanStatus: 'PENDING', scanLeaseToken: job.scanLeaseToken }, data });
    if (changed.count !== 1) return false;
    await tx.platformApplicationEvidenceEvent.create({ data: { evidenceId: job.id, eventType, actorKind: 'CLAMD_SCANNER', details } });
    return true;
  });
}

export async function processEvidenceJob({ db = prisma, client = privateStorageClient(), scan = scanWithClamd } = {}) {
  const job = await claimEvidenceJob(db);
  if (!job) return false;
  if (job.scanAttempts > MAX_ATTEMPTS) {
    await markScan(db, job, { scanStatus: 'FAILED', scanErrorCode: 'SCAN_LEASE_EXHAUSTED', scannedAt: new Date(), scanLeaseToken: null, scanLeaseExpiresAt: null }, 'SCAN_FAILED', { code: 'SCAN_LEASE_EXHAUSTED', attempt: job.scanAttempts });
    return true;
  }
  try {
    if (job.storageBucket !== PRIVATE_BUCKETS.hospitalEvidenceQuarantine) throw new Error('EVIDENCE_QUARANTINE_MISMATCH');
    const bytes = await downloadVerified(client, job.storageBucket, job.storageKey, job);
    const result = await scan(bytes);
    if (result.verdict === 'INFECTED') {
      await markScan(db, job, { scanStatus: 'INFECTED', scannedAt: new Date(), scannerVersion: result.scannerVersion, scanLeaseToken: null, scanLeaseExpiresAt: null }, 'SCAN_INFECTED', { signature: result.signature, sha256: job.sha256 });
      return true;
    }
    if (result.verdict !== 'CLEAN' || !result.scannerVersion) throw new Error('CLAMD_SCAN_UNCERTAIN');
    const released = await releaseCleanObject(client, job, bytes);
    const committed = await markScan(db, job, { scanStatus: 'CLEAN', storageBucket: released.bucket, storageKey: released.path, scannedAt: new Date(), scannerVersion: result.scannerVersion, scanLeaseToken: null, scanLeaseExpiresAt: null }, 'SCAN_CLEAN', { sha256: job.sha256, scannerVersion: result.scannerVersion });
    if (committed) {
      try {
        const { error } = await client.storage.from(job.storageBucket).remove([job.storageKey]);
        if (error) console.error('[evidence-scanner] Quarantine cleanup requires operator follow-up.');
      } catch { console.error('[evidence-scanner] Quarantine cleanup requires operator follow-up.'); }
    }
    return true;
  } catch (error) {
    const code = /^[A-Z_]{4,64}$/.test(error?.message || '') ? error.message : 'EVIDENCE_SCAN_FAILED';
    const terminal = job.scanAttempts >= MAX_ATTEMPTS || ['EVIDENCE_INTEGRITY_MISMATCH', 'EVIDENCE_QUARANTINE_MISMATCH', 'EVIDENCE_CONTENT_TYPE_INVALID'].includes(code);
    await markScan(db, job, {
      scanStatus: terminal ? 'FAILED' : 'PENDING', scanErrorCode: code, scanLeaseToken: null,
      scanLeaseExpiresAt: terminal ? null : new Date(Date.now() + Math.min(30, 2 ** job.scanAttempts) * 60_000),
      ...(terminal ? { scannedAt: new Date() } : {}),
    }, terminal ? 'SCAN_FAILED' : 'SCAN_RETRY_SCHEDULED', { code, attempt: job.scanAttempts });
    return true;
  }
}

export function startEvidenceScanner() {
  if (process.env.EVIDENCE_SCANNER_ENABLED !== 'true') return () => {};
  clamdAddress();
  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try { await processEvidenceJob(); }
    catch { console.error('[evidence-scanner] Poll failed; the job remains queued.'); }
    finally { running = false; }
  };
  const timer = setInterval(poll, 15_000);
  timer.unref();
  void poll();
  return () => clearInterval(timer);
}
