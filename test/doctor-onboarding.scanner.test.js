import { Buffer, Blob } from 'node:buffer';
import crypto from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const db = { doctorCredential: { findMany: vi.fn(), updateMany: vi.fn() }, activityLog: { create: vi.fn() }, $transaction: vi.fn() };
vi.mock('../src/config/db.js', () => ({ default: db }));
const { processDoctorCredentialJob } = await import('../src/modules/doctors/onboarding.scanner.js');
const bytes = Buffer.from('%PDF-1.7\nsynthetic');
const job = { id: 'test-document', applicationId: 'test-app', application: { professional: { userId: 'doctor-owner' } }, storageBucket: 'sabi-hospital-evidence-quarantine', storageKey: 'synthetic.pdf', byteSize: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), contentType: 'application/pdf', scanAttempts: 0, scanStatus: 'PENDING' };
const quarantine = { download: vi.fn() }, clean = { upload: vi.fn(), download: vi.fn() };
const client = { storage: { getBucket: vi.fn(), from: (bucket) => bucket === 'sabi-hospital-evidence-clean' ? clean : quarantine } };
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('DOCTOR_REGISTRATION_ENABLED', 'true'); vi.stubEnv('EVIDENCE_SCANNER_ENABLED', 'true'); vi.stubEnv('EVIDENCE_SCANNER_PROVIDER', 'cloudmersive'); vi.stubEnv('CLOUDMERSIVE_API_KEY', 'synthetic'); vi.stubEnv('CLOUDMERSIVE_CREDENTIAL_PROCESSING_APPROVED', 'true');
  db.$transaction.mockImplementation(async (work) => work(db)); db.doctorCredential.findMany.mockResolvedValue([job]); db.doctorCredential.updateMany.mockResolvedValue({ count: 1 });
  db.activityLog.create.mockImplementation(async ({ data }) => { if (!data.userId) throw new Error('ActivityLog.userId is required'); return {}; });
  client.storage.getBucket.mockResolvedValue({ data: { public: false } }); quarantine.download.mockResolvedValue({ data: new Blob([bytes]) }); clean.upload.mockResolvedValue({ data: { path: 'clean.pdf' } });
});
afterEach(() => vi.unstubAllEnvs());
describe('doctor asynchronous malware screening', () => {
  it('releases CLEAN content only into a private bucket and records scanner provenance', async () => {
    const scan = vi.fn(async () => ({ verdict: 'CLEAN', scannerVersion: 'Cloudmersive advanced v1' }));
    expect(await processDoctorCredentialJob({ db, client, scan })).toBe(true);
    expect(clean.upload.mock.calls[0][2].upsert).toBe(false);
    expect(db.doctorCredential.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ scanStatus: 'CLEAN', storageBucket: 'sabi-hospital-evidence-clean', scannerVersion: 'Cloudmersive advanced v1', scannedAt: expect.any(Date) }) }));
    expect(db.activityLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'doctor-owner', type: 'DOCTOR_SCAN_CLEAN', meta: expect.objectContaining({ actorKind: 'SYSTEM_SCANNER' }) }) }));
  });
  it.each(['INFECTED', 'REJECTED'])('never releases a %s verdict', async (verdict) => {
    await processDoctorCredentialJob({ db, client, scan: async () => ({ verdict, scannerVersion: 'Synthetic scanner' }) });
    expect(clean.upload).not.toHaveBeenCalled(); expect(db.doctorCredential.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ scanStatus: verdict }) }));
  });
  it('does not scan tampered content', async () => {
    quarantine.download.mockResolvedValue({ data: new Blob(['tampered']) }); const scan = vi.fn();
    await processDoctorCredentialJob({ db, client, scan }); expect(scan).not.toHaveBeenCalled(); expect(clean.upload).not.toHaveBeenCalled();
    expect(db.doctorCredential.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ scanStatus: 'FAILED', scanErrorCode: 'EVIDENCE_INTEGRITY_MISMATCH' }) }));
  });
  it('retries rate limits with backoff and fails closed after the attempt limit', async () => {
    const scan = async () => { throw new Error('CLOUDMERSIVE_RATE_LIMITED'); };
    await processDoctorCredentialJob({ db, client, scan }); expect(db.doctorCredential.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ scanStatus: 'PENDING', scanLeaseExpiresAt: expect.any(Date) }) }));
    db.doctorCredential.findMany.mockResolvedValue([{ ...job, scanAttempts: 4 }]); await processDoctorCredentialJob({ db, client, scan });
    expect(db.doctorCredential.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ scanStatus: 'FAILED' }) })); expect(clean.upload).not.toHaveBeenCalled();
  });
  it('rejects uncertain replies even if a provider claims clean without provenance', async () => {
    await processDoctorCredentialJob({ db, client, scan: async () => ({ verdict: 'CLEAN' }) }); expect(clean.upload).not.toHaveBeenCalled();
    expect(db.doctorCredential.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ scanStatus: 'PENDING', scanErrorCode: 'EVIDENCE_SCAN_UNCERTAIN' }) }));
  });
  it('cannot publish audit state for a stale lease', async () => {
    db.doctorCredential.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await processDoctorCredentialJob({ db, client, scan: async () => ({ verdict: 'CLEAN', scannerVersion: 'Synthetic' }) }); expect(db.activityLog.create).not.toHaveBeenCalled();
  });
  it('does no work while doctor intake is gated off', async () => {
    vi.stubEnv('DOCTOR_REGISTRATION_ENABLED', 'false'); expect(await processDoctorCredentialJob({ db, client })).toBe(false); expect(db.doctorCredential.findMany).not.toHaveBeenCalled();
  });
});
