import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

export const PRIVATE_BUCKETS = Object.freeze({
  hospitalEvidenceQuarantine: 'sabi-hospital-evidence-quarantine',
  hospitalEvidenceClean: 'sabi-hospital-evidence-clean',
  clinicalDocuments: 'sabi-clinical-documents',
  profileImages: 'sabi-profile-images',
});

export class PrivateStorageError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PrivateStorageError';
    this.code = code;
  }
}

// Only the trusted Node API receives the secret key. Never use this client in
// browser code or log its configuration. Sabi Auth remains the session authority.
export function privateStorageClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new PrivateStorageError('PRIVATE_STORAGE_NOT_CONFIGURED');
  let parsed;
  try { parsed = new URL(url); } catch { throw new PrivateStorageError('PRIVATE_STORAGE_NOT_CONFIGURED'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.supabase.co') || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new PrivateStorageError('PRIVATE_STORAGE_NOT_CONFIGURED');
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function assertPrivateBucket(client, bucket) {
  if (!Object.values(PRIVATE_BUCKETS).includes(bucket)) throw new PrivateStorageError('PRIVATE_STORAGE_BUCKET_NOT_ALLOWED');
  const { data, error } = await client.storage.getBucket(bucket);
  if (error || !data) throw new PrivateStorageError('PRIVATE_STORAGE_BUCKET_UNAVAILABLE');
  if (data.public !== false) throw new PrivateStorageError('PRIVATE_STORAGE_BUCKET_PUBLIC');
  return data;
}

export async function uploadPrivateObject(client, { bucket, path, bytes, contentType }) {
  await assertPrivateBucket(client, bucket);
  if (!/^[a-z0-9/_-]{1,250}\.(pdf|jpg|jpeg|png)$/.test(path) || !Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 10 * 1024 * 1024) {
    throw new PrivateStorageError('PRIVATE_STORAGE_UPLOAD_INVALID');
  }
  if (!['application/pdf', 'image/jpeg', 'image/png'].includes(contentType)) throw new PrivateStorageError('PRIVATE_STORAGE_UPLOAD_INVALID');
  const signatureMatches = contentType === 'application/pdf' ? bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
    : contentType === 'image/jpeg' ? bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      : bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!signatureMatches) throw new PrivateStorageError('PRIVATE_STORAGE_UPLOAD_INVALID');
  const { data, error } = await client.storage.from(bucket).upload(path, bytes, { contentType, upsert: false, cacheControl: '0' });
  if (error || !data?.path) throw new PrivateStorageError('PRIVATE_STORAGE_UPLOAD_FAILED');
  return { bucket, path: data.path };
}

// This is deliberately not exposed as an HTTP route. Reviewers must be MFA-
// authorized and a separate scanner must attest CLEAN before invoking it.
export async function signedEvidencePreview(client, evidence) {
  if (evidence.scanStatus !== 'CLEAN') throw new PrivateStorageError('EVIDENCE_NOT_CLEAN');
  if (evidence.bucket !== PRIVATE_BUCKETS.hospitalEvidenceClean) throw new PrivateStorageError('EVIDENCE_NOT_RELEASED');
  await assertPrivateBucket(client, evidence.bucket);
  const { data, error } = await client.storage.from(evidence.bucket).createSignedUrl(evidence.storageKey, 60);
  if (error || !data?.signedUrl) throw new PrivateStorageError('PRIVATE_STORAGE_PREVIEW_FAILED');
  return data.signedUrl;
}
