import { describe, expect, it, vi } from 'vitest';
import { PRIVATE_BUCKET_POLICIES, assertBucketPolicy, checkOrProvisionBuckets } from '../src/config/supabaseBuckets.js';

const bucketFor = (policy) => ({ id: policy.id, public: false, file_size_limit: policy.maxBytes, allowed_mime_types: policy.mimeTypes });

describe('Supabase private bucket provisioning', () => {
  it('rejects public or unrestricted pre-existing buckets', () => {
    const policy = PRIVATE_BUCKET_POLICIES[0];
    expect(() => assertBucketPolicy({ ...bucketFor(policy), public: true }, policy)).toThrow('PRIVATE_BUCKET_POLICY_MISMATCH');
    expect(() => assertBucketPolicy({ ...bucketFor(policy), allowed_mime_types: null }, policy)).toThrow('PRIVATE_BUCKET_POLICY_MISMATCH');
    expect(() => assertBucketPolicy({ ...bucketFor(policy), file_size_limit: 50 * 1024 * 1024 }, policy)).toThrow('PRIVATE_BUCKET_POLICY_MISMATCH');
    expect(() => assertBucketPolicy({ ...bucketFor(policy), allowed_mime_types: ['image/*'] }, policy)).toThrow('PRIVATE_BUCKET_POLICY_MISMATCH');
  });

  it('reports missing buckets without creating them by default', async () => {
    const storage = { getBucket: vi.fn().mockResolvedValue({ data: null, error: { statusCode: '404' } }), createBucket: vi.fn() };
    const result = await checkOrProvisionBuckets({ storage });
    expect(result).toHaveLength(4);
    expect(result.every((item) => item.state === 'MISSING')).toBe(true);
    expect(storage.createBucket).not.toHaveBeenCalled();
  });

  it('creates only missing private buckets with restrictive limits then verifies them', async () => {
    const storage = {
      getBucket: vi.fn(),
      createBucket: vi.fn().mockResolvedValue({ data: {}, error: null }),
    };
    for (const policy of PRIVATE_BUCKET_POLICIES) {
      storage.getBucket.mockResolvedValueOnce({ data: null, error: { statusCode: '404' } });
      storage.getBucket.mockResolvedValueOnce({ data: bucketFor(policy), error: null });
    }
    const result = await checkOrProvisionBuckets({ storage }, { apply: true });
    expect(result.every((item) => item.state === 'READY' && item.private)).toBe(true);
    expect(storage.createBucket).toHaveBeenCalledTimes(4);
    expect(storage.createBucket).toHaveBeenCalledWith(PRIVATE_BUCKET_POLICIES[0].id, expect.objectContaining({ public: false, fileSizeLimit: 10 * 1024 * 1024 }));
  });

  it('does not silently alter unsafe existing bucket settings', async () => {
    const policy = PRIVATE_BUCKET_POLICIES[0];
    const storage = { getBucket: vi.fn().mockResolvedValue({ data: { ...bucketFor(policy), public: true }, error: null }), createBucket: vi.fn() };
    await expect(checkOrProvisionBuckets({ storage }, { apply: true })).rejects.toThrow('PRIVATE_BUCKET_POLICY_MISMATCH');
    expect(storage.createBucket).not.toHaveBeenCalled();
  });
});
