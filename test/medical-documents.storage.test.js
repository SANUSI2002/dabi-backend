import { describe, expect, it } from 'vitest';
import { URL } from 'node:url';
import { R2DocumentStorage, readConfig, StorageUnavailableError } from '../src/modules/medical-documents/medical-documents.storage.js';
import { PRIVATE_BUCKETS } from '../src/config/privateStorage.js';

const r2 = { DOCUMENT_STORAGE_PROVIDER: 'r2', R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET: 'docs', R2_ENDPOINT: 'https://acct.r2.example' };
const supabase = {
  DOCUMENT_STORAGE_PROVIDER: 'supabase', SUPABASE_S3_ENDPOINT: 'https://ref.supabase.co/storage/v1/s3', SUPABASE_S3_REGION: 'eu-west-2',
  SUPABASE_S3_ACCESS_KEY_ID: 'key', SUPABASE_S3_SECRET_ACCESS_KEY: 'secret',
};

describe('medical document storage configuration', () => {
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
