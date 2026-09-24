import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRIVATE_BUCKETS, assertPrivateBucket, privateStorageClient, signedEvidencePreview, uploadPrivateObject } from '../src/config/privateStorage.js';

const previousUrl = process.env.SUPABASE_URL;
const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
afterEach(() => {
  if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousUrl;
  if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
});

const client = ({ bucket = { public: false }, upload = { path: 'applications/test/file.pdf' } } = {}) => ({ storage: {
  getBucket: vi.fn(async () => ({ data: bucket, error: null })),
  from: vi.fn(() => ({ upload: vi.fn(async () => ({ data: upload, error: null })), createSignedUrl: vi.fn(async () => ({ data: { signedUrl: 'https://example.supabase.co/signed' }, error: null })) })),
} });

describe('private Supabase Storage boundary', () => {
  it('rejects absent, insecure, or credential-bearing URLs before creating a client', () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => privateStorageClient()).toThrow('PRIVATE_STORAGE_NOT_CONFIGURED');
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only-key';
    for (const url of ['http://example.supabase.co/', 'https://evil.example/', 'https://secret@example.supabase.co/']) {
      process.env.SUPABASE_URL = url;
      expect(() => privateStorageClient()).toThrow('PRIVATE_STORAGE_NOT_CONFIGURED');
    }
  });

  it('rejects public and unexpected buckets', async () => {
    await expect(assertPrivateBucket(client({ bucket: { public: true } }), PRIVATE_BUCKETS.hospitalEvidenceQuarantine)).rejects.toThrow('PRIVATE_STORAGE_BUCKET_PUBLIC');
    await expect(assertPrivateBucket(client(), 'public-assets')).rejects.toThrow('PRIVATE_STORAGE_BUCKET_NOT_ALLOWED');
  });

  it('uploads only bounded allowlisted bytes without overwrite into a private bucket', async () => {
    const storage = client();
    const file = { bucket: PRIVATE_BUCKETS.hospitalEvidenceQuarantine, path: 'applications/test/file.pdf', bytes: Buffer.from('%PDF-1.7'), contentType: 'application/pdf' };
    await expect(uploadPrivateObject(storage, file)).resolves.toEqual({ bucket: file.bucket, path: file.path });
    const service = storage.storage.from.mock.results[0].value;
    expect(service.upload).toHaveBeenCalledWith(file.path, file.bytes, { contentType: file.contentType, upsert: false, cacheControl: '0' });
    await expect(uploadPrivateObject(storage, { ...file, path: '../file.pdf' })).rejects.toThrow('PRIVATE_STORAGE_UPLOAD_INVALID');
    await expect(uploadPrivateObject(storage, { ...file, contentType: 'text/html' })).rejects.toThrow('PRIVATE_STORAGE_UPLOAD_INVALID');
    await expect(uploadPrivateObject(storage, { ...file, bytes: Buffer.from('<html>fake pdf</html>') })).rejects.toThrow('PRIVATE_STORAGE_UPLOAD_INVALID');
  });

  it('never signs a preview before clean scan and release to the clean bucket', async () => {
    const storage = client();
    const evidence = { bucket: PRIVATE_BUCKETS.hospitalEvidenceClean, storageKey: 'applications/test/file.pdf', scanStatus: 'PENDING' };
    await expect(signedEvidencePreview(storage, evidence)).rejects.toThrow('EVIDENCE_NOT_CLEAN');
    await expect(signedEvidencePreview(storage, { ...evidence, scanStatus: 'CLEAN', bucket: PRIVATE_BUCKETS.hospitalEvidenceQuarantine })).rejects.toThrow('EVIDENCE_NOT_RELEASED');
    await expect(signedEvidencePreview(storage, { ...evidence, scanStatus: 'CLEAN' })).resolves.toContain('/signed');
  });
});
