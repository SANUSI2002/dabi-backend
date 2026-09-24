import { PRIVATE_BUCKETS, PrivateStorageError } from './privateStorage.js';

const evidenceTypes = ['application/pdf', 'image/jpeg', 'image/png'];

export const PRIVATE_BUCKET_POLICIES = Object.freeze([
  { id: PRIVATE_BUCKETS.hospitalEvidenceQuarantine, maxBytes: 10 * 1024 * 1024, mimeTypes: evidenceTypes },
  { id: PRIVATE_BUCKETS.hospitalEvidenceClean, maxBytes: 10 * 1024 * 1024, mimeTypes: evidenceTypes },
  { id: PRIVATE_BUCKETS.clinicalDocuments, maxBytes: 20 * 1024 * 1024, mimeTypes: evidenceTypes },
  { id: PRIVATE_BUCKETS.profileImages, maxBytes: 2 * 1024 * 1024, mimeTypes: ['image/jpeg', 'image/png'] },
]);

function readBucketLimit(bucket) {
  const value = bucket.file_size_limit ?? bucket.fileSizeLimit;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function assertBucketPolicy(bucket, policy) {
  if (!bucket || bucket.id !== policy.id || bucket.public !== false) throw new PrivateStorageError('PRIVATE_BUCKET_POLICY_MISMATCH');
  const limit = readBucketLimit(bucket);
  const types = bucket.allowed_mime_types ?? bucket.allowedMimeTypes;
  if (!limit || limit > policy.maxBytes || !Array.isArray(types) || types.length === 0 || types.some((type) => !policy.mimeTypes.includes(type))) {
    throw new PrivateStorageError('PRIVATE_BUCKET_POLICY_MISMATCH');
  }
  return { id: policy.id, private: true, maxBytes: limit, mimeTypes: [...types] };
}

export async function checkOrProvisionBuckets(client, { apply = false } = {}) {
  const results = [];
  for (const policy of PRIVATE_BUCKET_POLICIES) {
    let { data, error } = await client.storage.getBucket(policy.id);
    if (error && !['404', 404].includes(error.statusCode ?? error.status)) throw new PrivateStorageError('PRIVATE_BUCKET_CHECK_FAILED');
    if (!data) {
      if (!apply) { results.push({ id: policy.id, state: 'MISSING' }); continue; }
      const created = await client.storage.createBucket(policy.id, {
        public: false,
        allowedMimeTypes: policy.mimeTypes,
        fileSizeLimit: policy.maxBytes,
      });
      if (created.error) throw new PrivateStorageError('PRIVATE_BUCKET_CREATE_FAILED');
      ({ data, error } = await client.storage.getBucket(policy.id));
      if (error || !data) throw new PrivateStorageError('PRIVATE_BUCKET_CHECK_FAILED');
    }
    results.push({ ...assertBucketPolicy(data, policy), state: 'READY' });
  }
  return results;
}
