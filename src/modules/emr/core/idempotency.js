// Idempotency for critical creates (Idempotency-Key header).
//
// The key row is claimed with INSERT … ON CONFLICT DO NOTHING inside the *same* transaction as
// the create, so the create and its key commit or roll back together:
// - first request: claims the key, runs, stores the response;
// - a retry after success: finds the stored response and replays it (no duplicate record);
// - a concurrent duplicate: blocks on the key's unique index until the first commits, then replays;
// - same key, different request body: 422 IDEMPOTENCY_KEY_REUSED.
import { createHash } from 'node:crypto';
import { EmrError } from './errors.js';

const KEY = /^[A-Za-z0-9._:-]{16,128}$/;

export const readIdempotencyKey = (req) => {
  const key = req.get('idempotency-key');
  if (key === undefined) return null;
  if (!KEY.test(key)) throw new EmrError('VALIDATION_FAILED', { message: 'Idempotency-Key must be 16-128 characters (letters, digits, . _ : -).' });
  return key;
};

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  return value;
};
export const requestHash = (scope, body) => createHash('sha256').update(JSON.stringify([scope, stable(body ?? {})])).digest('hex');

/**
 * Runs `work(tx)` at most once per (tenant, scope, key). `work` returns { statusCode, body }.
 * Returns { statusCode, body, replayed }.
 */
export async function idempotent(tx, context, { key, scope, body }, work) {
  if (!key) return { ...(await work(tx)), replayed: false };
  const hash = requestHash(scope, body);
  const claimed = await tx.$queryRaw`
    INSERT INTO "emr_idempotency_keys" ("organization_id", "scope", "idempotency_key", "request_hash")
    VALUES (${context.organizationId}, ${scope}, ${key}, ${hash})
    ON CONFLICT DO NOTHING
    RETURNING "idempotency_key"`;
  if (!claimed.length) {
    const existing = await tx.emrIdempotencyKey.findUnique({
      where: { organizationId_scope_idempotencyKey: { organizationId: context.organizationId, scope, idempotencyKey: key } },
    });
    if (!existing || existing.requestHash !== hash) throw new EmrError('IDEMPOTENCY_KEY_REUSED');
    if (existing.statusCode == null) throw new EmrError('IDEMPOTENCY_IN_PROGRESS');
    return { statusCode: existing.statusCode, body: existing.responseBody, replayed: true };
  }
  const result = await work(tx);
  await tx.emrIdempotencyKey.update({
    where: { organizationId_scope_idempotencyKey: { organizationId: context.organizationId, scope, idempotencyKey: key } },
    data: { statusCode: result.statusCode, responseBody: JSON.parse(JSON.stringify(result.body)) },
  });
  return { ...result, replayed: false };
}
