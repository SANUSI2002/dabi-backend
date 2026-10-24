import { Storage } from '@google-cloud/storage';
import { Blob, Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const MAX_BYTES = 10 * 1024 * 1024;
const fail = () => { throw Object.assign(new Error('Private storage operation unavailable.'), { code: 'PRIVATE_STORAGE_UNAVAILABLE' }); };
const safePath = value => typeof value === 'string' && /^[a-z0-9/_-]{1,250}\.(pdf|jpg|jpeg|png)$/.test(value) && !value.startsWith('/') && !value.includes('//');
const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png'];

export function googleStorageConfigured(env = process.env) {
  return /^[a-z][a-z0-9-]{5,25}[a-z0-9]$/.test(env.GCS_BUCKET_PREFIX || '') && /^\d{6,20}$/.test(env.GOOGLE_CLOUD_PROJECT_NUMBER || '');
}

/** Server-only ADC. No downloaded service-account key or public bucket is used. */
export function createGoogleStorageClient(logicalBuckets, { sdk = new Storage(), env = process.env, now = Date.now } = {}) {
  if (!googleStorageConfigured(env)) fail();
  const names = new Set(Object.values(logicalBuckets));
  const policy = logical => logical === logicalBuckets.profileImages
    ? { maxBytes: 2 * 1024 * 1024, types: ['image/jpeg', 'image/png'] }
    : { maxBytes: MAX_BYTES, types: allowedTypes };
  function bucketFor(logical) {
    if (!names.has(logical)) fail();
    return sdk.bucket(`${env.GCS_BUCKET_PREFIX}-${logical.replace(/^sabi-/, '')}`);
  }
  async function assertBucket(logical) {
    const bucket = bucketFor(logical);
    const [metadata] = await bucket.getMetadata();
    if (String(metadata.projectNumber) !== env.GOOGLE_CLOUD_PROJECT_NUMBER
      || metadata.iamConfiguration?.publicAccessPrevention !== 'enforced'
      || metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true) fail();
    return bucket;
  }
  const result = async operation => {
    try { return { data: await operation(), error: null }; }
    catch { return { data: null, error: { code: 'PRIVATE_STORAGE_UNAVAILABLE', message: 'Private storage operation unavailable.' } }; }
  };
  return { provider: 'gcs', storage: {
    getBucket: logical => result(async () => {
      await assertBucket(logical);
      return { id: logical, public: false, file_size_limit: policy(logical).maxBytes, allowed_mime_types: policy(logical).types };
    }),
    from(logical) {
      // Validate before constructing a bucket handle, even when no I/O follows.
      bucketFor(logical);
      return {
        createSignedUpload: (key, contentType, byteSize, seconds = 300) => result(async () => {
          if (!safePath(key) || !key.startsWith('quarantine/') || !policy(logical).types.includes(contentType)
            || !Number.isSafeInteger(byteSize) || byteSize <= 0 || byteSize > policy(logical).maxBytes
            || !Number.isInteger(seconds) || seconds < 1 || seconds > 300) fail();
          const bucket = await assertBucket(logical);
          // Sign both limits: the browser cannot overwrite an existing object or
          // send more bytes than the authenticated initialization allowed.
          const extensionHeaders = { 'x-goog-if-generation-match': '0',
            'x-goog-content-length-range': `${byteSize},${byteSize}`,
            'cache-control': 'private, no-store, max-age=0' };
          const [url] = await bucket.file(key).getSignedUrl({ version: 'v4', action: 'write',
            expires: now() + seconds * 1000, contentType, extensionHeaders });
          return { method: 'PUT', url, expiresInSeconds: seconds,
            headers: { 'Content-Type': contentType, ...extensionHeaders } };
        }),
        inspect: (key, maxBytes = policy(logical).maxBytes) => result(async () => {
          if (!safePath(key) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > policy(logical).maxBytes) fail();
          const bucket = await assertBucket(logical);
          const [metadata] = await bucket.file(key).getMetadata();
          const byteSize = Number(metadata.size);
          if (!Number.isSafeInteger(byteSize) || byteSize <= 0 || byteSize > maxBytes
            || !policy(logical).types.includes(metadata.contentType) || !/^\d+$/.test(String(metadata.generation))) fail();
          const [bytes] = await bucket.file(key, { generation: metadata.generation }).download({ validation: 'crc32c' });
          if (bytes.length !== byteSize) fail();
          return { byteSize, contentType: metadata.contentType, sha256: createHash('sha256').update(bytes).digest('hex') };
        }),
        upload: (key, bytes, options = {}) => result(async () => {
          if (!safePath(key) || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > policy(logical).maxBytes
            || !policy(logical).types.includes(options.contentType) || options.upsert === true) fail();
          const bucket = await assertBucket(logical);
          await bucket.file(key).save(bytes, { resumable: false, validation: 'crc32c',
            preconditionOpts: { ifGenerationMatch: 0 },
            metadata: { contentType: options.contentType, cacheControl: 'private, no-store, max-age=0' } });
          return { path: key };
        }),
        download: key => result(async () => {
          if (!safePath(key)) fail();
          const bucket = await assertBucket(logical);
          const file = bucket.file(key);
          const [metadata] = await file.getMetadata();
          if (!Number.isSafeInteger(Number(metadata.size)) || Number(metadata.size) <= 0 || Number(metadata.size) > policy(logical).maxBytes
            || !policy(logical).types.includes(metadata.contentType) || !/^\d+$/.test(String(metadata.generation))) fail();
          // Read the same immutable generation that was size-checked.
          const [bytes] = await bucket.file(key, { generation: metadata.generation }).download({ validation: 'crc32c' });
          if (bytes.length !== Number(metadata.size)) fail();
          return new Blob([bytes], { type: metadata.contentType });
        }),
        createSignedUrl: (key, seconds, options = {}) => result(async () => {
          if (!safePath(key) || !Number.isInteger(seconds) || seconds < 1 || seconds > 300) fail();
          const bucket = await assertBucket(logical);
          const file = bucket.file(key);
          const [metadata] = await file.getMetadata();
          if (!/^\d+$/.test(String(metadata.generation))) fail();
          const filename = typeof options.download === 'string' ? options.download.replace(/[\r\n"\\]/g, '_').slice(0, 120) : 'document';
          const [signedUrl] = await file.getSignedUrl({ version: 'v4', action: 'read', expires: now() + seconds * 1000,
            queryParams: { generation: String(metadata.generation) },
            ...(options.download ? { promptSaveAs: filename } : {}) });
          return { signedUrl };
        }),
        remove: keys => result(async () => {
          if (!Array.isArray(keys) || keys.length > 50 || keys.some(key => !safePath(key))) fail();
          const bucket = await assertBucket(logical);
          for (const key of keys) {
            const file = bucket.file(key);
            try {
              const [metadata] = await file.getMetadata();
              if (!/^\d+$/.test(String(metadata.generation))) fail();
              await file.delete({ ifGenerationMatch: metadata.generation });
            } catch (error) { if (Number(error.code) !== 404) throw error; }
          }
          return keys.map(name => ({ name }));
        }),
      };
    },
  } };
}
