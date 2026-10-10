import { Prisma } from "@prisma/client";
import prisma from "../../config/db.js";
import { owner, audit } from "./portal.service.js";
import { fail } from "./portal.policy.js";

const DAY = 86400000;
export function reportWindow(from, to) {
  const start = new Date(`${from}T00:00:00+01:00`),
    last = new Date(`${to}T00:00:00+01:00`);
  if (
    ![start, last].every((d) => Number.isFinite(d.getTime())) ||
    start > last ||
    last - start >= 366 * DAY
  )
    fail("Choose a valid date range of no more than 366 days.", 400);
  // Reject date rollover (e.g. February 31), not only invalid JavaScript dates.
  if (
    [start, last].some(
      (d, i) =>
        new Date(d.getTime() + 3600000).toISOString().slice(0, 10) !==
        [from, to][i],
    )
  )
    fail("Use valid calendar dates.", 400);
  return { start, end: new Date(last.getTime() + DAY) };
}
export const csvCell = (value) => {
  let text = String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
export const toCsv = (headers, rows) =>
  "\uFEFF" +
  [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") +
  "\r\n";
const number = (value) => {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n))
    fail(
      "Report total exceeds safe display limits. Narrow the date range.",
      422,
    );
  return n;
};
const normalize = (row) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "bigint" ? number(value) : value,
    ]),
  );
async function scope(tx, userId, org, branchId) {
  const p = await owner(tx, userId, org);
  if (branchId && !p.branches.some((b) => b.id === branchId))
    fail("Branch not found in this pharmacy.", 404);
  return p;
}
const stockSelect = Prisma.sql`
  SELECT i.id,i.branch_id AS "branchId",b.name AS "branchName",i.medication_name AS "medicationName",
    i.batch_number AS "batchNumber",i.expiry_date AS "expiryDate",i.available_quantity AS "availableQuantity",
    i.unit_price_minor AS "unitPriceMinor",i.reorder_point AS "reorderPoint",i.reorder_target AS "reorderTarget",
    i.stock_policy_version AS "stockPolicyVersion",i.is_active AS "isActive",l.status AS "listingStatus",
    COALESCE((SELECT SUM(ra.selected_quantity) FROM reservation_allocations ra JOIN reservations r ON r.id=ra.reservation_id
      WHERE ra.inventory_item_id=i.id AND r.status='ACTIVE'),0)::bigint AS "reservedUnits",
    COALESCE((SELECT SUM(a.selected_quantity) FROM order_allocations a JOIN order_fulfilments f ON f.id=a.fulfilment_id JOIN orders o ON o.id=f.order_id
      WHERE a.inventory_item_id=i.id AND f.inventory_finalized_at IS NULL AND o.status IN ('PAID','PENDING_PAYMENT')
      AND f.status NOT IN ('CANCELLED','REJECTED','UNABLE_TO_FULFILL')),0)::bigint AS "orderAllocatedUnits"
  FROM pharmacy_inventory_items i LEFT JOIN pharmacy_branches b ON b.id=i.branch_id AND b.pharmacy_id=i.pharmacy_id
  LEFT JOIN pharmacy_listings l ON l.inventory_item_id=i.id`;
function stockFilters(p, query) {
  const clauses = [Prisma.sql`i.pharmacy_id=${p.id}`];
  if (query.branchId) clauses.push(Prisma.sql`i.branch_id=${query.branchId}`);
  if (query.search)
    clauses.push(
      Prisma.sql`(i.medication_name ILIKE ${`%${query.search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`} OR i.batch_number ILIKE ${`%${query.search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`})`,
    );
  if (query.state === "LOW")
    clauses.push(
      Prisma.sql`i.is_active=true AND i.available_quantity <= i.reorder_point`,
    );
  if (query.state === "OUT")
    clauses.push(Prisma.sql`i.is_active=true AND i.available_quantity=0`);
  if (query.state === "EXPIRED")
    clauses.push(
      Prisma.sql`i.expiry_date < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`,
    );
  if (query.state === "EXPIRING")
    clauses.push(
      Prisma.sql`i.expiry_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date AND i.expiry_date <= ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date + ${query.expiryDays}::int)`,
    );
  if (query.state === "INACTIVE") clauses.push(Prisma.sql`i.is_active=false`);
  return Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}`;
}
export async function stockReport(userId, org, query, { csv = false } = {}) {
  return prisma.$transaction(
    async (tx) => {
      const p = await scope(tx, userId, org, query.branchId);
      const filter = stockFilters(p, query);
      const summaryRows =
        await tx.$queryRaw`SELECT COUNT(*)::bigint AS "batchCount",COALESCE(SUM(i.available_quantity),0)::bigint AS "availableUnits",
      COALESCE(SUM(i.available_quantity::bigint*i.unit_price_minor),0)::bigint AS "retailValueMinor",
      COUNT(*) FILTER (WHERE i.is_active AND i.available_quantity <= i.reorder_point)::bigint AS "lowStockBatches",
      COUNT(*) FILTER (WHERE i.expiry_date < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date)::bigint AS "expiredBatches"
      FROM pharmacy_inventory_items i ${filter}`;
      const rows =
        await tx.$queryRaw`${stockSelect} ${filter} ORDER BY i.expiry_date ASC NULLS LAST,i.medication_name,i.id LIMIT ${csv ? 5001 : 51} OFFSET ${csv ? 0 : (query.page - 1) * 50}`;
      if (csv && rows.length > 5000)
        fail(
          "Export exceeds 5,000 batches. Filter by branch or stock state.",
          422,
        );
      await audit(
        tx,
        userId,
        csv ? "PHARMACY_STOCK_EXPORTED" : "PHARMACY_STOCK_REPORT_VIEWED",
        {
          pharmacyId: p.id,
          branchId: query.branchId || null,
          state: query.state,
          page: query.page,
        },
      );
      const items = rows
        .map(normalize)
        .map((r) => ({
          ...r,
          suggestedReorderQuantity:
            r.reorderTarget === null
              ? null
              : Math.max(0, r.reorderTarget - r.availableQuantity),
        }));
      if (csv)
        return toCsv(
          [
            "Branch",
            "Product",
            "Batch",
            "Expiry UTC",
            "Available units",
            "Reservation units",
            "Order allocated units",
            "Retail unit price kobo",
            "Reorder point",
            "Reorder target",
            "Suggested reorder units",
            "Active",
            "Listing state",
          ],
          items.map((r) => [
            r.branchName,
            r.medicationName,
            r.batchNumber,
            r.expiryDate?.toISOString().slice(0, 10),
            r.availableQuantity,
            r.reservedUnits,
            r.orderAllocatedUnits,
            r.unitPriceMinor,
            r.reorderPoint,
            r.reorderTarget,
            r.suggestedReorderQuantity,
            r.isActive,
            r.listingStatus,
          ]),
        );
      return {
        items: items.slice(0, 50),
        summary: normalize(summaryRows[0]),
        nextPage: rows.length > 50 ? query.page + 1 : null,
        generatedAt: new Date().toISOString(),
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
export async function stockPolicy(userId, org, id, input) {
  if (input.reorderTarget !== null && input.reorderTarget < input.reorderPoint)
    fail("Reorder target must be at least the reorder point.", 400);
  return prisma.$transaction(async (tx) => {
    const p = await owner(tx, userId, org, { lock: true });
    const changed = await tx.pharmacyInventoryItem.updateMany({
      where: { id, pharmacyId: p.id, stockPolicyVersion: input.version },
      data: {
        reorderPoint: input.reorderPoint,
        reorderTarget: input.reorderTarget,
        stockPolicyVersion: { increment: 1 },
      },
    });
    if (!changed.count)
      fail("Stock policy changed or is not available. Refresh and retry.", 409);
    await audit(tx, userId, "PHARMACY_REORDER_POLICY_CHANGED", {
      pharmacyId: p.id,
      inventoryItemId: id,
      ...input,
    });
    return { saved: true, version: input.version + 1 };
  });
}
export async function adjustmentHistory(userId, org, id, page) {
  return prisma.$transaction(async (tx) => {
    const p = await scope(tx, userId, org);
    const item = await tx.pharmacyInventoryItem.findFirst({
      where: { id, pharmacyId: p.id },
      select: { id: true, medicationName: true },
    });
    if (!item) fail("Inventory item not found.", 404);
    const rows = await tx.pharmacyStockAdjustment.findMany({
      where: { inventoryItemId: id },
      select: {
        id: true,
        quantityDelta: true,
        balanceBefore: true,
        balanceAfter: true,
        reason: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
      skip: (page - 1) * 50,
    });
    await audit(tx, userId, "PHARMACY_STOCK_HISTORY_VIEWED", {
      pharmacyId: p.id,
      inventoryItemId: id,
      page,
    });
    return {
      item,
      items: rows.slice(0, 50),
      nextPage: rows.length > 50 ? page + 1 : null,
    };
  });
}

export async function salesReport(userId, org, query, { csv = false } = {}) {
  const { start, end } = reportWindow(query.from, query.to);
  return prisma.$transaction(
    async (tx) => {
      const p = await scope(tx, userId, org, query.branchId);
      // A pharmacy fulfilment can span stock from several branches in legacy RX orders.
      // Branch filtering selects whole fulfilments and is explicitly labelled, not prorated.
      const branch = query.branchId
        ? Prisma.sql`AND EXISTS(SELECT 1 FROM order_allocations a JOIN pharmacy_inventory_items i ON i.id=a.inventory_item_id WHERE a.fulfilment_id=f.id AND i.pharmacy_id=${p.id} AND i.branch_id=${query.branchId})`
        : Prisma.empty;
      const base = Prisma.sql`FROM order_fulfilments f JOIN orders o ON o.id=f.order_id
      JOIN LATERAL(SELECT MIN(completed_at) AS paid_at FROM payment_attempts WHERE order_id=o.id AND status='SUCCESS') paid ON paid.paid_at IS NOT NULL
      WHERE f.pharmacy_id=${p.id} AND o.currency='NGN' AND o.status='PAID' AND paid.paid_at >= ${start} AND paid.paid_at < ${end} ${branch}`;
      const totals =
        await tx.$queryRaw`SELECT COUNT(*)::bigint AS "paidFulfilments",COALESCE(SUM(f.subtotal_minor),0)::bigint AS "productSubtotalMinor",
      COALESCE(SUM(f.commission_minor),0)::bigint AS "commissionMinor",COALESCE(SUM(f.delivery_fee_minor),0)::bigint AS "deliveryFeesMinor",
      COALESCE(SUM(CASE WHEN f.commission_minor IS NOT NULL THEN f.subtotal_minor-f.commission_minor ELSE 0 END),0)::bigint AS "productNetBeforeRefundsMinor",
      COUNT(*) FILTER(WHERE f.commission_minor IS NULL)::bigint AS "legacyCommissionUnknown",
      COALESCE(SUM((SELECT rc.amount_minor FROM refund_review_cases rc WHERE rc.fulfilment_id=f.id AND rc.status='PENDING_REVIEW')),0)::bigint AS "refundReviewMinor" ${base}`;
      const daily =
        await tx.$queryRaw`SELECT to_char((paid.paid_at AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos','YYYY-MM-DD') AS day,
      COUNT(*)::bigint AS "paidFulfilments",SUM(f.subtotal_minor)::bigint AS "productSubtotalMinor",SUM(COALESCE(f.commission_minor,0))::bigint AS "commissionMinor"
      ${base} GROUP BY day ORDER BY day`;
      const ordersByStatus =
        await tx.$queryRaw`SELECT o.status,COUNT(*)::bigint AS count FROM order_fulfilments f JOIN orders o ON o.id=f.order_id
      WHERE f.pharmacy_id=${p.id} AND o.currency='NGN' AND f.created_at >= ${start} AND f.created_at < ${end} ${branch} GROUP BY o.status ORDER BY o.status`;
      const rows =
        await tx.$queryRaw`SELECT f.id,o.reference, f.status,f.fulfilment_method AS "fulfilmentMethod",f.subtotal_minor AS "subtotalMinor",
      f.delivery_fee_minor AS "deliveryFeeMinor",f.commission_minor AS "commissionMinor",f.commission_bps AS "commissionBps",f.tier_version AS "tierVersion",paid.paid_at AS "paidAt"
      ${base} ORDER BY paid.paid_at DESC,f.id LIMIT ${csv ? 5001 : 51} OFFSET ${csv ? 0 : (query.page - 1) * 50}`;
      if (csv && rows.length > 5000)
        fail("Export exceeds 5,000 fulfilments. Narrow the date range.", 422);
      await audit(
        tx,
        userId,
        csv ? "PHARMACY_SALES_EXPORTED" : "PHARMACY_SALES_REPORT_VIEWED",
        {
          pharmacyId: p.id,
          from: query.from,
          to: query.to,
          branchId: query.branchId || null,
        },
      );
      if (csv)
        return toCsv(
          [
            "Order reference",
            "Fulfilment ID",
            "Paid at UTC",
            "State",
            "Method",
            "Product subtotal kobo",
            "Delivery fee kobo",
            "Commission kobo",
            "Commission bps",
            "Policy version",
          ],
          rows.map((r) => [
            r.reference,
            r.id,
            r.paidAt.toISOString(),
            r.status,
            r.fulfilmentMethod,
            r.subtotalMinor,
            r.deliveryFeeMinor,
            r.commissionMinor,
            r.commissionBps,
            r.tierVersion,
          ]),
        );
      return {
        items: rows.slice(0, 50),
        summary: normalize(totals[0]),
        daily: daily.map(normalize),
        ordersByStatus: ordersByStatus.map(normalize),
        nextPage: rows.length > 50 ? query.page + 1 : null,
        from: query.from,
        to: query.to,
        timezone: "Africa/Lagos",
        generatedAt: new Date().toISOString(),
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
