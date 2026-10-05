import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scanWithCloudmersive } from '../src/modules/platform/platform.cloudmersive.js';
import { evidenceUploadMaxBytes, evidenceScannerConfigured } from '../src/config/evidenceScanner.js';
import { unscannedExceptionEnabled } from '../src/modules/platform/platform.evidence-mode.js';

const clean = { CleanResult: true, FoundViruses: [], VerifiedFileFormat: 'PDF', ContainsExecutable: false,
  ContainsInvalidFile: false, ContainsScript: false, ContainsPasswordProtectedFile: false,
  ContainsRestrictedFileFormat: false, ContainsMacros: false };
const bytes = Buffer.from('%PDF-1.7\nsynthetic only');
const job = { contentType: 'application/pdf', fileName: 'PRIVATE-NAME-NOT-SENT.pdf' };
const response = (data = clean, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(data) });
beforeEach(() => {
  vi.stubEnv('CLOUDMERSIVE_API_KEY', 'synthetic-not-a-real-key');
  vi.stubEnv('CLOUDMERSIVE_CREDENTIAL_PROCESSING_APPROVED', 'true');
  vi.stubEnv('EVIDENCE_SCANNER_PROVIDER', 'cloudmersive');
  vi.stubEnv('EVIDENCE_SCANNER_ENABLED', 'true');
  vi.stubEnv('CLOUDMERSIVE_MAX_FILE_BYTES', '3500000');
});
afterEach(() => vi.unstubAllEnvs());
describe('Cloudmersive credential scanner', () => {
  it('sends multipart bytes only with a generic filename and a server-side key', async () => {
    const fetcher = vi.fn(async () => response());
    await expect(scanWithCloudmersive(bytes, job, fetcher)).resolves.toMatchObject({ verdict: 'CLEAN' });
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.cloudmersive.com/virus/scan/file/advanced');
    expect(options.headers.Apikey).toBe('synthetic-not-a-real-key');
    expect(options.redirect).toBe('error');
    const file = options.body.get('inputFile');
    expect(file.name).toBe('credential.pdf');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
    expect(JSON.stringify(options.headers)).not.toContain(job.fileName);
    expect(options.headers.restrictFileTypes).toBe('.pdf,.jpg,.jpeg,.png');
  });
  it('requires the explicit credential-processing gate and configured key', async () => {
    vi.stubEnv('CLOUDMERSIVE_CREDENTIAL_PROCESSING_APPROVED', 'false');
    const fetcher = vi.fn();
    expect(evidenceScannerConfigured()).toBe(false);
    await expect(scanWithCloudmersive(bytes, job, fetcher)).rejects.toThrow('CLOUDMERSIVE_NOT_CONFIGURED');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('enforces the free-tier limit before sending anything', async () => {
    const fetcher = vi.fn();
    expect(evidenceUploadMaxBytes()).toBe(3500000);
    await expect(scanWithCloudmersive(Buffer.alloc(3500001), job, fetcher)).rejects.toThrow('CLOUDMERSIVE_FILE_TOO_LARGE');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('never converts an infected response to clean', async () => {
    await expect(scanWithCloudmersive(bytes, job, async () => response({ ...clean, FoundViruses: [{ VirusName: 'Synthetic test' }] }))).resolves.toMatchObject({ verdict: 'INFECTED' });
  });
  it.each(['ContainsScript', 'ContainsMacros', 'ContainsPasswordProtectedFile', 'ContainsInvalidFile', 'ContainsExecutable', 'ContainsRestrictedFileFormat', 'ContainsUnsafeArchive'])('rejects unsafe %s content even with CleanResult=true', async (key) => {
    await expect(scanWithCloudmersive(bytes, job, async () => response({ ...clean, [key]: true }))).resolves.toMatchObject({ verdict: 'REJECTED' });
  });
  it.each([{}, { CleanResult: 'true', FoundViruses: [] }, { ...clean, FoundViruses: null }, { ...clean, ContainsScript: 'false' }])('fails closed on malformed response %j', async (data) => {
    await expect(scanWithCloudmersive(bytes, job, async () => response(data))).rejects.toThrow('CLOUDMERSIVE_REPLY_INVALID');
  });
  it('rejects file type mismatch', async () => {
    await expect(scanWithCloudmersive(bytes, job, async () => response({ ...clean, VerifiedFileFormat: 'HTML' }))).rejects.toThrow('CLOUDMERSIVE_FORMAT_MISMATCH');
  });
  it.each([[401, 'CLOUDMERSIVE_AUTH_FAILED'], [403, 'CLOUDMERSIVE_AUTH_FAILED'], [429, 'CLOUDMERSIVE_RATE_LIMITED'], [413, 'CLOUDMERSIVE_FILE_TOO_LARGE'], [503, 'CLOUDMERSIVE_UNAVAILABLE']])('handles HTTP %s without exposing provider response', async (status, code) => {
    await expect(scanWithCloudmersive(bytes, job, async () => response({ private: 'SECRET-DOCUMENT-NAME' }, status))).rejects.toThrow(code);
  });
  it('fails closed on network errors', async () => {
    await expect(scanWithCloudmersive(bytes, job, async () => { throw new Error('secret provider error'); })).rejects.toThrow('CLOUDMERSIVE_UNAVAILABLE');
  });
  it('never falls back to the temporary bypass when Cloudmersive is selected', () => {
    vi.stubEnv('HOSPITAL_UNSCANNED_EXCEPTION_ENABLED', 'true');
    vi.stubEnv('HOSPITAL_UNSCANNED_EXCEPTION_UNTIL', new Date(Date.now() + 86400000).toISOString().slice(0, 19) + 'Z');
    vi.stubEnv('CLOUDMERSIVE_API_KEY', '');
    expect(unscannedExceptionEnabled()).toBe(false);
    expect(evidenceScannerConfigured()).toBe(false);
  });
});
