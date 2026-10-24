import { describe, expect, it } from 'vitest';
import { URL } from 'node:url';
import { GoogleDocumentStorage, R2DocumentStorage, getUploadMaxBytes, readConfig, StorageUnavailableError } from '../src/modules/medical-documents/medical-documents.storage.js';
import { vi } from 'vitest';
import { PRIVATE_BUCKETS } from '../src/config/privateStorage.js';

const r2 = { DOCUMENT_STORAGE_PROVIDER: 'r2', R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET: 'docs', R2_ENDPOINT: 'https://acct.r2.example' };
const supabase = {
  DOCUMENT_STORAGE_PROVIDER: 'supabase', SUPABASE_S3_ENDPOINT: 'https://ref.supabase.co/storage/v1/s3', SUPABASE_S3_REGION: 'eu-west-2',
  SUPABASE_S3_ACCESS_KEY_ID: 'key', SUPABASE_S3_SECRET_ACCESS_KEY: 'secret',
};

describe('medical document storage configuration', () => {
  it('selects keyless Google storage even when a legacy provider value remains', () => {
    const env = { PRIVATE_STORAGE_PROVIDER: 'gcs', GCS_BUCKET_PREFIX: 'sabi-prod-556396127853', GOOGLE_CLOUD_PROJECT_NUMBER: '556396127853' };
    expect(readConfig({ ...r2, ...env })).toEqual({ provider: 'gcs', bucket: PRIVATE_BUCKETS.clinicalDocuments, ttl: 300 });
    expect(() => readConfig({ ...env, GOOGLE_CLOUD_PROJECT_NUMBER: '' })).toThrow(StorageUnavailableError);
    expect(() => readConfig({ ...env, DOCUMENT_SIGNED_URL_TTL_SECONDS: '900' })).toThrow(StorageUnavailableError);
  });

  it('routes Google operations through the verified private adapter and sanitises failures', async () => {
    const objects = { createSignedUpload: vi.fn(async () => ({ data: { method: 'PUT' }, error: null })),
      inspect: vi.fn(async () => ({ data: { byteSize: 68, sha256: 'a'.repeat(64) }, error: null })),
      remove: vi.fn(async () => ({ data: [], error: null })) };
    const from = vi.fn(() => objects);
    const storage = new GoogleDocumentStorage({ client: { provider: 'gcs', storage: { from } }, config: { provider: 'gcs', ttl: 60 } });
    expect(await storage.createUpload({ objectKey: 'quarantine/test.pdf', contentType: 'application/pdf', byteSize: 68 })).toEqual({ method: 'PUT' });
    expect(objects.createSignedUpload).toHaveBeenCalledWith('quarantine/test.pdf', 'application/pdf', 68, 60);
    expect(await storage.head('quarantine/test.pdf')).toMatchObject({ byteSize: 68 });
    await storage.delete('quarantine/test.pdf');
    expect(from).toHaveBeenCalledWith(PRIVATE_BUCKETS.clinicalDocuments);
    objects.inspect.mockResolvedValueOnce({ data: null, error: { message: 'provider-private-detail' } });
    await expect(storage.head('quarantine/test.pdf')).rejects.toThrow('Document storage is unavailable');
  });

  it('caps Google uploads at the scanner allowance without changing legacy limits', () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { PRIVATE_STORAGE_PROVIDER: 'gcs', DOCUMENT_UPLOAD_MAX_BYTES: '10485760', CLOUDMERSIVE_MAX_FILE_BYTES: '3500000' });
      expect(getUploadMaxBytes()).toBe(3500000);
      process.env.CLOUDMERSIVE_MAX_FILE_BYTES = '99999999';
      expect(getUploadMaxBytes()).toBe(3500000);
    } finally { process.env = saved; }
  });
  it('keeps the R2 configuration unchanged', () => {
    expect(readConfig(r2)).toMatchObject({ bucket: 'docs', endpoint: 'https://acct.r2.example', region: 'auto', forcePathStyle: false, ttl: 300 });
  });

  it('uses the private clinical-documents bucket with path-style addressing on Supabase', () => {
    expect(readConfig(supabase)).toMatchObject({
      bucket: PRIVATE_BUCKETS.clinicalDocuments, endpoint: supabase.SUPABASE_S3_ENDPOINT, region: 'eu-west-2', forcePathStyle: true,
      credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
    });
  });

  it.each([
    ['no provider', {}],
    ['an unknown provider', { ...supabase, DOCUMENT_STORAGE_PROVIDER: 'public-bucket' }],
    ['a missing Supabase secret', { ...supabase, SUPABASE_S3_SECRET_ACCESS_KEY: ' ' }],
    ['a missing R2 account id', { ...r2, R2_ACCOUNT_ID: '' }],
    ['a signed-URL lifetime above 15 minutes', { ...supabase, DOCUMENT_SIGNED_URL_TTL_SECONDS: '3600' }],
  ])('fails closed with %s', (_, env) => {
    expect(() => readConfig(env)).toThrow(StorageUnavailableError);
  });

  it('issues upload URLs a browser can PUT any file to (no presign-time body checksum)', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, supabase);
    try {
      const upload = await new R2DocumentStorage().createUpload({ objectKey: 'quarantine/test', contentType: 'application/pdf', byteSize: 68 });
      expect(upload.method).toBe('PUT');
      expect([...new URL(upload.url).searchParams.keys()].filter((key) => /checksum/i.test(key))).toEqual([]);
    } finally {
      process.env = saved;
    }
  });
});
