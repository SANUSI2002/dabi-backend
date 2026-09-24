import crypto from 'node:crypto';
import { Blob, Buffer } from 'node:buffer';
import net from 'node:net';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bytes = Buffer.from('%PDF-1.7\nsynthetic-scanner-test');
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const job = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', applicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  storageBucket: 'sabi-hospital-evidence-quarantine', storageKey: 'applications/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/upload.pdf',
  scanStatus: 'PENDING', scanAttempts: 0, contentType: 'application/pdf', sizeBytes: bytes.length, sha256, createdAt: new Date(),
};
const db = {
  platformApplicationEvidence: { findMany: vi.fn(), updateMany: vi.fn() },
  platformApplicationEvidenceEvent: { create: vi.fn() },
  $transaction: vi.fn(async (callback) => callback(db)),
};
const quarantine = { download: vi.fn(), remove: vi.fn() };
const clean = { upload: vi.fn(), download: vi.fn() };
const client = { storage: { getBucket: vi.fn(), from: vi.fn((bucket) => bucket === 'sabi-hospital-evidence-clean' ? clean : quarantine) } };
vi.mock('../src/config/db.js', () => ({ default: db }));
const { processEvidenceJob, scanWithClamd } = await import('../src/modules/platform/platform.evidence-scanner.js');
const originalClamdHost = process.env.CLAMD_HOST;
const originalClamdPort = process.env.CLAMD_PORT;
afterEach(() => {
  if (originalClamdHost === undefined) delete process.env.CLAMD_HOST; else process.env.CLAMD_HOST = originalClamdHost;
  if (originalClamdPort === undefined) delete process.env.CLAMD_PORT; else process.env.CLAMD_PORT = originalClamdPort;
});

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation(async (callback) => callback(db));
  db.platformApplicationEvidence.findMany.mockResolvedValue([job]);
  db.platformApplicationEvidence.updateMany.mockResolvedValue({ count: 1 });
  db.platformApplicationEvidenceEvent.create.mockResolvedValue({});
  client.storage.getBucket.mockResolvedValue({ data: { public: false }, error: null });
  quarantine.download.mockResolvedValue({ data: new Blob([bytes]), error: null });
  quarantine.remove.mockResolvedValue({ error: null });
  clean.upload.mockResolvedValue({ data: { path: `applications/${job.applicationId}/${job.id}.pdf` }, error: null });
});

describe('asynchronous evidence scanner', () => {
  it('uses the ClamAV INSTREAM protocol and accepts a fresh clean verdict', async () => {
    const received = [];
    const server = net.createServer((socket) => {
      let pending = Buffer.alloc(0);
      let command = '';
      socket.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        if (!command) {
          const end = pending.indexOf(0);
          if (end === -1) return;
          command = pending.subarray(0, end).toString('utf8');
          pending = pending.subarray(end + 1);
          if (command === 'zVERSION') { socket.end(`ClamAV 1.4.0/12345/${new Date().toUTCString()}\0`); return; }
        }
        while (command === 'zINSTREAM' && pending.length >= 4) {
          const size = pending.readUInt32BE(0);
          if (pending.length < size + 4) break;
          pending = pending.subarray(4);
          if (size === 0) { socket.end('stream: OK\0'); break; }
          received.push(pending.subarray(0, size));
          pending = pending.subarray(size);
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    process.env.CLAMD_HOST = '127.0.0.1';
    process.env.CLAMD_PORT = String(server.address().port);
    try {
      await expect(scanWithClamd(bytes)).resolves.toEqual(expect.objectContaining({ verdict: 'CLEAN' }));
      expect(Buffer.concat(received)).toEqual(bytes);
    } finally { server.close(); await once(server, 'close'); }
  });
  it('claims once, verifies bytes, releases clean object, and audits the result', async () => {
    const scan = vi.fn(async () => ({ verdict: 'CLEAN', scannerVersion: 'ClamAV test-version' }));
    expect(await processEvidenceJob({ db, client, scan })).toBe(true);
    expect(scan).toHaveBeenCalledWith(bytes);
    expect(clean.upload).toHaveBeenCalledWith(expect.stringContaining(job.id), bytes, expect.objectContaining({ upsert: false }));
    expect(db.platformApplicationEvidence.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ scanStatus: 'CLEAN', storageBucket: 'sabi-hospital-evidence-clean' }) }));
    expect(db.platformApplicationEvidenceEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'SCAN_CLEAN', actorKind: 'CLAMD_SCANNER' }) });
    expect(quarantine.remove).toHaveBeenCalledWith([job.storageKey]);
  });

  it('never releases an infected file', async () => {
    const scan = vi.fn(async () => ({ verdict: 'INFECTED', scannerVersion: 'ClamAV test-version', signature: 'Eicar-Test-Signature' }));
    expect(await processEvidenceJob({ db, client, scan })).toBe(true);
    expect(clean.upload).not.toHaveBeenCalled();
    expect(quarantine.remove).not.toHaveBeenCalled();
    expect(db.platformApplicationEvidence.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ scanStatus: 'INFECTED' }) }));
  });

  it('fails closed on byte-integrity mismatch', async () => {
    quarantine.download.mockResolvedValue({ data: new Blob([Buffer.from('%PDF-corrupt')]), error: null });
    const scan = vi.fn();
    expect(await processEvidenceJob({ db, client, scan })).toBe(true);
    expect(scan).not.toHaveBeenCalled();
    expect(clean.upload).not.toHaveBeenCalled();
    expect(db.platformApplicationEvidence.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ scanStatus: 'FAILED', scanErrorCode: 'EVIDENCE_INTEGRITY_MISMATCH' }) }));
  });

  it('retries uncertain scanner responses without releasing the file', async () => {
    const scan = vi.fn(async () => { throw new Error('CLAMD_SCAN_UNCERTAIN'); });
    expect(await processEvidenceJob({ db, client, scan })).toBe(true);
    expect(clean.upload).not.toHaveBeenCalled();
    expect(db.platformApplicationEvidence.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ scanStatus: 'PENDING', scanErrorCode: 'CLAMD_SCAN_UNCERTAIN' }) }));
  });

  it('closes a job whose final scanner lease expired without an outcome', async () => {
    db.platformApplicationEvidence.findMany.mockResolvedValue([{ ...job, scanAttempts: 5 }]);
    const scan = vi.fn();
    expect(await processEvidenceJob({ db, client, scan })).toBe(true);
    expect(scan).not.toHaveBeenCalled();
    expect(db.platformApplicationEvidence.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ scanStatus: 'FAILED', scanErrorCode: 'SCAN_LEASE_EXHAUSTED' }) }));
  });
});
