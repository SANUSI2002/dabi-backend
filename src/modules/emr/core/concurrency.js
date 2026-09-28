// Optimistic concurrency: every mutable record has a `version`. Reads return it as a weak
// ETag; updates must send it back in If-Match. A stale version → 412 VERSION_CONFLICT (the
// second editor reloads instead of silently overwriting the first); no header → 428.
import { EmrError } from './errors.js';

export const etagFor = (version) => `W/"${version}"`;

export const requireVersion = (req) => {
  const header = req.get('if-match');
  if (!header) throw new EmrError('PRECONDITION_REQUIRED');
  const match = /^(?:W\/)?"?(\d{1,9})"?$/.exec(header.trim());
  if (!match) throw new EmrError('VALIDATION_FAILED', { message: 'If-Match must be the record version, e.g. W/"3".' });
  return Number(match[1]);
};

/**
 * Applies an update only if the row is still at `expectedVersion`, bumping the version.
 * `model` is a Prisma delegate on the tenant transaction (e.g. tx.emrPatient).
 * Returns the updated row; throws notFoundCode / VERSION_CONFLICT otherwise.
 */
export async function updateVersioned(model, { organizationId, id, expectedVersion, data, select, notFoundCode = 'NOT_FOUND' }) {
  const { count } = await model.updateMany({ where: { organizationId, id, version: expectedVersion }, data: { ...data, version: { increment: 1 } } });
  if (count === 1) return model.findFirst({ where: { organizationId, id }, select });
  const current = await model.findFirst({ where: { organizationId, id }, select: { version: true } });
  if (!current) throw new EmrError(notFoundCode);
  throw new EmrError('VERSION_CONFLICT', { details: { currentVersion: current.version }, headers: { ETag: etagFor(current.version) } });
}
