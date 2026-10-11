// /api/v1/command-centre/pharmacy-exceptions — read-only, platform-wide view of marketplace
// pharmacy stock that needs attention: published products out of stock or at/below their reorder
// point, batches with units on hand that have expired or expire soon, and listings withdrawn by
// the pharmacy or rejected in review. Grouped by pharmacy and branch. Marketplace inventory only;
// EMR (hospital) stock is tenant data and is never read here.
import express from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { allow, handle, pageQuery, paged } from './cc.common.js';

export const pharmacyRoutes = express.Router();

export const EXCEPTION_TYPES = ['OUT_OF_STOCK', 'LOW_STOCK', 'EXPIRED', 'EXPIRING', 'WITHDRAWN', 'REJECTED'];

export const DEFINITIONS = {
  OUT_OF_STOCK: 'Active product with a published listing and no units available.',
  LOW_STOCK: 'Active product with a published listing whose available units are at or below the pharmacy’s reorder point (or the threshold you set, if higher), but above zero.',
  EXPIRED: 'Batch with units still on hand whose expiry date is before today (UTC).',
  EXPIRING: 'Batch with units on hand that expires today or within the chosen window (30, 60 or 90 days).',
  WITHDRAWN: 'Listing the pharmacy withdrew from the marketplace and has not resubmitted.',
  REJECTED: 'Listing a Sabi reviewer rejected and the pharmacy has not resubmitted.',
};

const query = z.object({
  ...pageQuery,
  type: z.enum(EXCEPTION_TYPES).optional(),
  within: z.coerce.number().int().refine((n) => [30, 60, 90].includes(n), 'Choose 30, 60 or 90 days').default(90),
  lowStockAt: z.coerce.number().int().min(0).max(1_000_000).default(0),
  pharmacyId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  search: z.string().trim().min(1).max(100).optional(),
}).strict();

const like = (s) => `%${s.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;

/** Every inventory item with its exception flags, before filtering. */
function flagged({ within, lowStockAt }) {
  const today = Prisma.sql`(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`;
  return Prisma.sql`
    SELECT i.id, i.pharmacy_id AS "pharmacyId", p.name AS "pharmacyName", p.compliance_status::text AS "pharmacyStatus",
      i.branch_id AS "branchId", b.name AS "branchName", b.status AS "branchStatus",
      i.medication_name AS "medicationName", i.batch_number AS "batchNumber", i.expiry_date AS "expiryDate",
      i.available_quantity AS "availableQuantity", i.reorder_point AS "reorderPoint", i.is_active AS "isActive",
      l.id AS "listingId", l.status AS "listingStatus", l.review_note AS "reviewNote", l.reviewed_at AS "reviewedAt",
      l.updated_at AS "listingUpdatedAt",
      (i.expiry_date - ${today})::int AS "daysToExpiry",
      (l.status = 'PUBLISHED' AND i.is_active AND i.available_quantity <= 0) AS "outOfStock",
      (l.status = 'PUBLISHED' AND i.is_active AND i.available_quantity > 0
        AND i.available_quantity <= GREATEST(i.reorder_point, ${lowStockAt}::int)) AS "lowStock",
      (i.available_quantity > 0 AND i.expiry_date < ${today}) AS "expired",
      (i.available_quantity > 0 AND i.expiry_date >= ${today} AND i.expiry_date <= ${today} + ${within}::int) AS "expiring",
      (i.available_quantity > 0 AND i.expiry_date >= ${today} AND i.expiry_date <= ${today} + 30) AS "expiring30",
      (i.available_quantity > 0 AND i.expiry_date >= ${today} AND i.expiry_date <= ${today} + 60) AS "expiring60",
      (i.available_quantity > 0 AND i.expiry_date >= ${today} AND i.expiry_date <= ${today} + 90) AS "expiring90",
      (l.status = 'WITHDRAWN') AS "withdrawn",
      (l.status = 'REJECTED') AS "rejected"
    FROM pharmacy_inventory_items i
    JOIN pharmacies p ON p.id = i.pharmacy_id
    LEFT JOIN pharmacy_branches b ON b.id = i.branch_id AND b.pharmacy_id = i.pharmacy_id
    LEFT JOIN pharmacy_listings l ON l.inventory_item_id = i.id`;
}

const FLAG = { OUT_OF_STOCK: 'outOfStock', LOW_STOCK: 'lowStock', EXPIRED: 'expired', EXPIRING: 'expiring', WITHDRAWN: 'withdrawn', REJECTED: 'rejected' };

function where(q) {
  // Column names come from FLAG (fixed), never from the request.
  const flags = q.type ? [FLAG[q.type]] : Object.values(FLAG);
  const clauses = [Prisma.raw(`(${flags.map((f) => `x."${f}"`).join(' OR ')})`)];
  if (q.pharmacyId) clauses.push(Prisma.sql`x."pharmacyId" = ${q.pharmacyId}`);
  if (q.branchId) clauses.push(Prisma.sql`x."branchId" = ${q.branchId}`);
  if (q.search) clauses.push(Prisma.sql`(x."medicationName" ILIKE ${like(q.search)} OR x."batchNumber" ILIKE ${like(q.search)} OR x."pharmacyName" ILIKE ${like(q.search)})`);
  return Prisma.sql`WHERE ${Prisma.join(clauses, ' AND ')}`;
}

const typesOf = (r) => EXCEPTION_TYPES.filter((t) => r[FLAG[t]]);
const band = (r) => (r.expired ? 'EXPIRED' : r.expiring30 ? '30' : r.expiring60 ? '60' : r.expiring90 ? '90' : null);
const dateOnly = (d) => (d ? d.toISOString().slice(0, 10) : null);
const iso = (d) => (d ? d.toISOString() : null);

pharmacyRoutes.get('/', allow('platform.ops.read'),
  validate(z.object({ query, params: z.object({}).strict() }).passthrough()),
  handle(async (req) => {
    const q = req.query;
    const base = flagged(q);
    const filter = where(q);
    const severity = Prisma.sql`CASE WHEN x."expired" THEN 0 WHEN x."outOfStock" THEN 1 WHEN x."expiring30" THEN 2 WHEN x."lowStock" THEN 3 WHEN x."expiring" THEN 4 WHEN x."rejected" THEN 5 ELSE 6 END`;
    const [summaryRows, groups, countRows, rows] = await Promise.all([
      // Platform-wide totals, independent of the filters, so the tiles never change under a filter.
      prisma.$queryRaw`SELECT
          COUNT(*) FILTER (WHERE x."outOfStock")::int AS "outOfStock", COUNT(*) FILTER (WHERE x."lowStock")::int AS "lowStock",
          COUNT(*) FILTER (WHERE x."expired")::int AS "expired", COUNT(*) FILTER (WHERE x."expiring30")::int AS "expiring30",
          COUNT(*) FILTER (WHERE x."expiring60")::int AS "expiring60", COUNT(*) FILTER (WHERE x."expiring90")::int AS "expiring90",
          COUNT(*) FILTER (WHERE x."withdrawn")::int AS "withdrawn", COUNT(*) FILTER (WHERE x."rejected")::int AS "rejected",
          COUNT(DISTINCT x."pharmacyId") FILTER (WHERE x."outOfStock" OR x."lowStock" OR x."expired" OR x."expiring90" OR x."withdrawn" OR x."rejected")::int AS "pharmacies"
        FROM (${base}) x`,
      prisma.$queryRaw`SELECT x."pharmacyId", MIN(x."pharmacyName") AS "pharmacyName", MIN(x."pharmacyStatus") AS "pharmacyStatus",
          x."branchId", MIN(x."branchName") AS "branchName", MIN(x."branchStatus") AS "branchStatus", COUNT(*)::int AS "items",
          COUNT(*) FILTER (WHERE x."outOfStock")::int AS "outOfStock", COUNT(*) FILTER (WHERE x."lowStock")::int AS "lowStock",
          COUNT(*) FILTER (WHERE x."expired")::int AS "expired", COUNT(*) FILTER (WHERE x."expiring")::int AS "expiring",
          COUNT(*) FILTER (WHERE x."withdrawn")::int AS "withdrawn", COUNT(*) FILTER (WHERE x."rejected")::int AS "rejected"
        FROM (${base}) x ${filter}
        GROUP BY x."pharmacyId", x."branchId" ORDER BY MIN(x."pharmacyName"), MIN(x."branchName") NULLS FIRST, x."pharmacyId", x."branchId" LIMIT 500`,
      prisma.$queryRaw`SELECT COUNT(*)::int AS "total" FROM (${base}) x ${filter}`,
      prisma.$queryRaw`SELECT x.* FROM (${base}) x ${filter}
        ORDER BY x."pharmacyName", x."pharmacyId", x."branchName" NULLS FIRST, x."branchId", ${severity}, x."expiryDate" NULLS LAST, x."medicationName", x.id
        LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
    ]);
    const items = rows.map((r) => ({
      id: r.id,
      types: typesOf(r),
      pharmacy: { id: r.pharmacyId, name: r.pharmacyName, status: r.pharmacyStatus },
      branch: r.branchId ? { id: r.branchId, name: r.branchName, status: r.branchStatus } : null,
      medicationName: r.medicationName,
      batchNumber: r.batchNumber,
      expiryDate: dateOnly(r.expiryDate),
      daysToExpiry: r.daysToExpiry,
      expiryBand: band(r),
      availableQuantity: r.availableQuantity,
      reorderPoint: r.reorderPoint,
      isActive: r.isActive,
      listing: r.listingId ? { id: r.listingId, status: r.listingStatus, reviewNote: r.rejected ? r.reviewNote : null, reviewedAt: iso(r.reviewedAt), updatedAt: iso(r.listingUpdatedAt) } : null,
    }));
    return {
      generatedAt: new Date().toISOString(),
      freshness: 'Live: read from the primary database when this response was generated.',
      filters: { type: q.type ?? null, within: q.within, lowStockAt: q.lowStockAt, pharmacyId: q.pharmacyId ?? null, branchId: q.branchId ?? null, search: q.search ?? null },
      definitions: DEFINITIONS,
      summary: summaryRows[0],
      groups: groups.map((g) => ({
        pharmacy: { id: g.pharmacyId, name: g.pharmacyName, status: g.pharmacyStatus },
        branch: g.branchId ? { id: g.branchId, name: g.branchName, status: g.branchStatus } : null,
        counts: { items: g.items, outOfStock: g.outOfStock, lowStock: g.lowStock, expired: g.expired, expiring: g.expiring, withdrawn: g.withdrawn, rejected: g.rejected },
      })),
      ...paged(items, countRows[0].total, q),
    };
  }));
