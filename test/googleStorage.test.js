import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoogleStorageClient, googleStorageConfigured } from '../src/config/googleStorage.js';

const env = { GCS_BUCKET_PREFIX: 'sabi-prod-556396127853', GOOGLE_CLOUD_PROJECT_NUMBER: '556396127853' };
const buckets = { clinicalDocuments: 'sabi-clinical-documents', profileImages: 'sabi-profile-images' };
const bytes = Buffer.from('%PDF-synthetic');
let sdk, bucket, file, metadata;
beforeEach(() => {
  metadata = { projectNumber: env.GOOGLE_CLOUD_PROJECT_NUMBER, iamConfiguration: { publicAccessPrevention: 'enforced', uniformBucketLevelAccess: { enabled: true } } };
  file = { save: vi.fn(), getMetadata: vi.fn(async () => [{ generation: '123', size: String(bytes.length), contentType: 'application/pdf' }]),
    download: vi.fn(async () => [bytes]), getSignedUrl: vi.fn(async () => ['https://storage.googleapis.com/synthetic-signed-url']), delete: vi.fn() };
  bucket = { getMetadata: vi.fn(async () => [metadata]), file: vi.fn(() => file) };
  sdk = { bucket: vi.fn(() => bucket) };
});
const client = () => createGoogleStorageClient(buckets, { sdk, env, now: () => 1000 });
const storage = () => client().storage.from(buckets.clinicalDocuments);
describe('Google Cloud private storage', () => {
  it('requires explicit project and bucket configuration, never external credentials', () => {
    expect(googleStorageConfigured({})).toBe(false);
    expect(googleStorageConfigured(env)).toBe(true);
    expect(() => createGoogleStorageClient(buckets, { sdk, env: {} })).toThrow();
    expect(() => client().storage.from('arbitrary-bucket')).toThrow();
  });
  it('maps approved logical buckets to project-scoped names', async () => {
    expect((await client().storage.getBucket(buckets.clinicalDocuments)).data).toMatchObject({ id: buckets.clinicalDocuments, public: false });
    expect(sdk.bucket).toHaveBeenCalledWith('sabi-prod-556396127853-clinical-documents');
  });
  it.each(['public-access', 'acl-enabled', 'wrong-project'])('fails closed for %s', async reason => {
    if(reason === 'public-access')metadata.iamConfiguration.publicAccessPrevention = 'inherited';
    if(reason === 'acl-enabled')metadata.iamConfiguration.uniformBucketLevelAccess.enabled = false;
    if(reason === 'wrong-project')metadata.projectNumber = '999999999999';
    expect((await storage().upload('quarantine/test.pdf', bytes, { contentType: 'application/pdf' })).error).toBeTruthy();
    expect(file.save).not.toHaveBeenCalled();
  });
  it('creates immutable objects with CRC validation and no-store metadata', async () => {
    const result = await storage().upload('quarantine/test.pdf', bytes, { contentType: 'application/pdf', upsert: false });
    expect(result.error).toBeNull();
    expect(file.save).toHaveBeenCalledWith(bytes, expect.objectContaining({ validation: 'crc32c', preconditionOpts: { ifGenerationMatch: 0 }, metadata: expect.objectContaining({ cacheControl: 'private, no-store, max-age=0' }) }));
    expect((await storage().upload('quarantine/test.pdf', bytes, { contentType: 'application/pdf', upsert: true })).error).toBeTruthy();
  });
  it('signs only bounded, immutable quarantine uploads with exact byte limits', async () => {
    const signed = await storage().createSignedUpload('quarantine/test.pdf', 'application/pdf', bytes.length, 60);
    expect(signed.error).toBeNull();
    expect(signed.data.headers).toMatchObject({ 'Content-Type': 'application/pdf', 'x-goog-if-generation-match': '0',
      'x-goog-content-length-range': `${bytes.length},${bytes.length}` });
    expect(file.getSignedUrl).toHaveBeenCalledWith({ version: 'v4', action: 'write', expires: 61000,
      contentType: 'application/pdf', extensionHeaders: expect.objectContaining({ 'x-goog-if-generation-match': '0',
        'x-goog-content-length-range': `${bytes.length},${bytes.length}`, 'cache-control': 'private, no-store, max-age=0' }) });
    for (const [key, type, size, ttl] of [
      ['clean/test.pdf', 'application/pdf', bytes.length, 60],
      ['../test.pdf', 'application/pdf', bytes.length, 60],
      ['quarantine/test.pdf', 'text/html', bytes.length, 60],
      ['quarantine/test.pdf', 'application/pdf', 0, 60],
      ['quarantine/test.pdf', 'application/pdf', 10485761, 60],
      ['quarantine/test.pdf', 'application/pdf', bytes.length, 301],
    ]) expect((await storage().createSignedUpload(key, type, size, ttl)).error).toBeTruthy();
    expect(file.getSignedUrl).toHaveBeenCalledTimes(1);
  });
  it('checks the exact generation and hashes bytes before releasing an upload for scanning', async () => {
    expect((await storage().inspect('quarantine/test.pdf', 100)).data).toEqual({ byteSize: bytes.length,
      contentType: 'application/pdf', sha256: createHash('sha256').update(bytes).digest('hex') });
    expect(bucket.file).toHaveBeenCalledWith('quarantine/test.pdf', { generation: '123' });
    expect((await storage().inspect('quarantine/test.pdf', 1)).error).toBeTruthy();
    file.download.mockResolvedValueOnce([Buffer.from('wrong-length')]);
    expect((await storage().inspect('quarantine/test.pdf', 100)).error).toBeTruthy();
  });
  it('enforces profile-image type and size limits in the application, not imaginary bucket settings', async () => {
    const images = client().storage.from(buckets.profileImages);
    expect((await images.upload('profile/test.pdf', bytes, { contentType: 'application/pdf' })).error).toBeTruthy();
    expect((await images.upload('profile/test.jpg', Buffer.alloc(2 * 1024 * 1024 + 1), { contentType: 'image/jpeg' })).error).toBeTruthy();
    expect(file.save).not.toHaveBeenCalled();
  });
  it('downloads only the exact size-checked generation and returns a bounded blob', async () => {
    const result = await storage().download('clean/test.pdf');
    expect(Buffer.from(await result.data.arrayBuffer())).toEqual(bytes);
    expect(bucket.file).toHaveBeenCalledWith('clean/test.pdf', { generation: '123' });
    file.getMetadata.mockResolvedValueOnce([{ generation: '123', size: '999999999', contentType: 'application/pdf' }]);
    expect((await storage().download('clean/test.pdf')).error).toBeTruthy();
    expect(file.download).toHaveBeenCalledTimes(1);
  });
  it('signs a generation-pinned read for only the requested short lifetime', async () => {
    expect((await storage().createSignedUrl('clean/test.pdf', 60)).error).toBeNull();
    expect(file.getSignedUrl).toHaveBeenCalledWith({ version: 'v4', action: 'read', expires: 61000, queryParams: { generation: '123' } });
    expect((await storage().createSignedUrl('clean/test.pdf', 3600)).error).toBeTruthy();
    expect((await storage().createSignedUrl('../test.pdf', 60)).error).toBeTruthy();
  });
  it('deletes conditionally, treats missing bytes idempotently and hides provider errors', async () => {
    expect((await storage().remove(['quarantine/test.pdf'])).error).toBeNull();
    expect(file.delete).toHaveBeenCalledWith({ ifGenerationMatch: '123' });
    file.getMetadata.mockRejectedValueOnce({ code: 404 });
    expect((await storage().remove(['quarantine/test.pdf'])).error).toBeNull();
    file.save.mockRejectedValue(new Error('PROVIDER_SECRET_NOT_FOR_CLIENT'));
    const failed = await storage().upload('quarantine/test.pdf', bytes, { contentType: 'application/pdf' });
    expect(JSON.stringify(failed)).not.toContain('PROVIDER_SECRET');
  });
});
