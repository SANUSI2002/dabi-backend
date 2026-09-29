// "Entered in error": clinical entries are never edited or deleted. A wrong entry is marked, with
// who/when/why, and a correct one recorded. Only the marking columns are writable by the request
// role (column-level grants), so this is the one way such rows change.
import { EmrError } from './errors.js';

/**
 * Marks the ACTIVE row matching `where` as ENTERED_IN_ERROR. `statusField` names the row's
 * status column ('status' for most entries, 'entryStatus' for MAR entries).
 * Throws notFoundCode when no such row exists, INVALID_STATE when it is already marked.
 */
export async function markEnteredInError(model, { where, statusField = 'status', userId, reason, notFoundCode, label = 'entry' }) {
  const { count } = await model.updateMany({
    where: { ...where, [statusField]: 'ACTIVE' },
    data: { [statusField]: 'ENTERED_IN_ERROR', errorReason: reason, erroredByUserId: userId, erroredAt: new Date() },
  });
  const row = await model.findFirst({ where });
  if (!row) throw new EmrError(notFoundCode);
  if (!count) throw new EmrError('INVALID_STATE', { message: `This ${label} is already marked as entered in error.` });
  return row;
}
