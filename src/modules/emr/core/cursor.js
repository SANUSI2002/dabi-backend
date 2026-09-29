// Keyset-pagination cursors shared by every EMR list: an opaque base64url of "<timestamp>|<id>".
// Lists order by (timestamp, id) and continue strictly after the cursor row, so paging stays
// cheap and stable however deep the client goes.
import { Buffer } from 'node:buffer';
import { EmrError } from './errors.js';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const encodeCursor = (at, id) => Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');

/** Returns { at, id }, or throws VALIDATION_FAILED for anything that is not a cursor we issued. */
export function decodeCursor(cursor) {
  const [iso, id, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const at = new Date(iso);
  if (extra !== undefined || !id || !ID.test(id) || Number.isNaN(at.getTime())) {
    throw new EmrError('VALIDATION_FAILED', { message: 'The cursor is not valid.' });
  }
  return { at, id };
}

/** Prisma where-fragment for rows after the cursor in (field, id) order. */
export function afterCursor(field, cursor, direction = 'desc') {
  if (!cursor) return {};
  const { at, id } = decodeCursor(cursor);
  const op = direction === 'desc' ? 'lt' : 'gt';
  return { OR: [{ [field]: { [op]: at } }, { [field]: at, id: { [op]: id } }] };
}

/** Slices a `take: limit + 1` result into a page and the next cursor. */
export function page(rows, limit, field) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? encodeCursor(rows[limit - 1][field], rows[limit - 1].id) : null };
}
