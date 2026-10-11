// Shared plumbing for the Command Centre API (/api/v1/command-centre).
//
// Every route runs behind protect + requirePlatform (a verified platform staff identity with no
// organization context). Each route then names the platform permission(s) it needs; nothing is
// visible to platform staff by default. Sensitive reads and every change take a stated reason and
// write an ADMIN audit entry (actor, time, target, reason; before/after for configuration).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireAnyPermission } from '../../middleware/accessMiddleware.js';
import { recordAudit } from '../audit/audit.service.js';

export const allow = (...permissions) => requireAnyPermission(...permissions);
export const can = (req, permission) => Boolean(req.accessContext?.permissions?.includes(permission));

/** A purpose for opening sensitive data or making a change: specific enough to review later. */
export const reason = z.string().trim().min(5, 'Give a reason of at least 5 characters').max(500).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');

export const ccError = (code, status, message, details) => Object.assign(new Error(code), { code, status, message, details, ccError: true });

/** Wraps an async handler; known errors become { status: 'error', error: { code, message, details } }. */
export const handle = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json({ status: 'success', data: result });
  } catch (error) {
    if (error.ccError || error.status) {
      return res.status(error.status ?? 400).json({ status: 'error', error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    }
    const known = { NOT_FOUND: 404, INVALID_STATE: 409, INVALID_PRICING: 400, REASON_REQUIRED: 400, NOT_SERVICEABLE: 422, INVALID_ORIGIN: 422, INVALID_DESTINATION: 400, INVALID_DISTANCE: 400, ROUTE_DISTANCE_UNAVAILABLE: 503 };
    if (known[error.code]) return res.status(known[error.code]).json({ status: 'error', error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    // Unexpected: log the detail on the server under a reference; never send internals to the browser.
    const ref = randomUUID().slice(0, 8);
    console.error(`[command-centre] ${ref} ${req.method} ${req.baseUrl}${req.route?.path ?? ''}:`, error?.message ?? error);
    return res.status(500).json({ status: 'error', error: { code: 'INTERNAL', message: `Something went wrong on the server (reference ${ref}).`, reference: ref } });
  }
};

/**
 * Records what a staff member did or opened. `before`/`after` are for configuration (never copy
 * clinical content into them); `reason` is the purpose they stated.
 */
export function adminAudit(db, req, { action = 'ADMIN_ACTION', summary, subjectUserId = null, resourceType = null, resourceId = null, reason: why = null, before, after, extra } = {}) {
  return recordAudit(db, {
    actorUserId: req.user.id,
    subjectUserId,
    action,
    summary,
    resourceType,
    resourceId,
    context: {
      roles: req.accessContext?.roles ?? [],
      ...(why ? { reason: why } : {}),
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      ...(extra ?? {}),
    },
  }, { req });
}

/** Page through a query newest-first with an opaque cursor "<iso>_<id>". */
export const cursorQuery = { cursor: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) };
export function afterCursor(cursor, field = 'createdAt') {
  if (!cursor) return {};
  const [at, id] = cursor.split('_');
  const when = new Date(at);
  if (!id || Number.isNaN(when.getTime())) throw ccError('INVALID_CURSOR', 400, 'The page cursor is not valid.');
  return { OR: [{ [field]: { lt: when } }, { [field]: when, id: { lt: id } }] };
}
export const pageOf = (rows, limit, field = 'createdAt') => ({
  items: rows.slice(0, limit),
  nextCursor: rows.length > limit ? `${rows[limit - 1][field].toISOString()}_${rows[limit - 1].id}` : null,
});

/** Date-range filters: ISO instants from the caller (who knows their own time zone). */
export const rangeQuery = {
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
};
export function rangeWhere(query, field = 'createdAt') {
  if (!query.from && !query.to) return {};
  return { [field]: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lt: new Date(query.to) } : {}) } };
}

/** a••••@example.com — enough to recognise an address without exposing it. */
export function maskEmail(email) {
  if (!email) return null;
  const [user, domain] = String(email).split('@');
  return domain ? `${user.slice(0, 1)}••••@${domain}` : '••••';
}
/** +234•••••6789 — last four digits only. */
export function maskPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  return digits.length > 4 ? `${String(phone).startsWith('+') ? '+' : ''}${digits.slice(0, 3)}•••••${digits.slice(-4)}` : '••••';
}
/** Names for a set of user ids (staff and patients), for display. */
export async function namesFor(db, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, full_name: true, email: true } });
  return new Map(rows.map((u) => [u.id, u.full_name || maskEmail(u.email) || 'Unnamed account']));
}
/** Offset pagination for admin lists that show "page N of M". */
export const pageQuery = { page: z.coerce.number().int().min(1).max(10_000).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) };
export const paged = (items, total, { page, limit }) => ({ items, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
