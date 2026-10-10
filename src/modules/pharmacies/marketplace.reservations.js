import { createHash } from "node:crypto";
import prisma from "../../config/db.js";
import { publicWhere, audit } from "./portal.service.js";
import { fail } from "./portal.policy.js";
import { RESERVATION_HOLD_MINUTES } from "../reservations/reservation.foundation.js";

export async function reserveMarketplace(patientId, input) {
  const lines = [...input.items].sort((a, b) =>
    a.listingId.localeCompare(b.listingId),
  );
  if (new Set(lines.map((i) => i.listingId)).size !== lines.length)
    fail("Each product must appear only once.", 400);
  const requestHash = createHash("sha256")
    .update(JSON.stringify(lines))
    .digest("hex");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id=${patientId} FOR UPDATE`;
    const user = await tx.user.findFirst({
      where: {
        id: patientId,
        accountStatus: "ACTIVE",
        emailVerifiedAt: { not: null },
        roles: { some: { role: "PATIENT" } },
      },
      select: { id: true },
    });
    if (!user) fail("An active verified patient account is required.", 403);
    const prior = await tx.reservation.findUnique({
      where: {
        patientId_idempotencyKey: {
          patientId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: { allocations: true },
    });
    if (prior) {
      if (prior.kind !== "MARKETPLACE" || prior.requestHash !== requestHash)
        fail("This checkout key was already used for a different cart.");
      if (prior.status !== "ACTIVE" || prior.expiresAt <= new Date())
        fail("This stock hold has expired or already been checked out.");
      return {
        id: prior.id,
        expiresAt: prior.expiresAt,
        allocations: prior.allocations,
        idempotent: true,
      };
    }
    const expiresAt = new Date(Date.now() + RESERVATION_HOLD_MINUTES * 60000);
    const allocations = [],
      branches = new Map();
    let total = 0;
    for (const line of lines) {
      // Lock each inventory row in a deterministic order, then reread eligibility.
      const candidate = await tx.pharmacyListing.findUnique({
        where: { id: line.listingId },
        select: { inventoryItemId: true },
      });
      if (!candidate) fail("A product is no longer available.");
      await tx.$queryRaw`SELECT id FROM pharmacy_inventory_items WHERE id=${candidate.inventoryItemId} FOR UPDATE`;
      const listing = await tx.pharmacyListing.findFirst({
        where: {
          id: line.listingId,
          ...publicWhere(),
          productClass: { not: "PRESCRIPTION_ONLY" },
        },
        include: { inventoryItem: true },
      });
      if (!listing)
        fail(
          "A product is no longer eligible for checkout. Refresh the catalogue.",
        );
      const item = listing.inventoryItem;
      if (
        branches.has(item.pharmacyId) &&
        branches.get(item.pharmacyId) !== item.branchId
      )
        fail("Choose products from one branch per pharmacy for this checkout.");
      branches.set(item.pharmacyId, item.branchId);
      const cost = item.unitPriceMinor * line.quantity;
      total += cost;
      if (!Number.isSafeInteger(total) || total > 1_000_000_000)
        fail("The order value exceeds the supported limit.", 400);
      const held = await tx.pharmacyInventoryItem.updateMany({
        where: {
          id: item.id,
          isActive: true,
          availableQuantity: { gte: line.quantity },
        },
        data: { availableQuantity: { decrement: line.quantity } },
      });
      if (!held.count)
        fail("There is not enough stock for this cart. Refresh and retry.");
      allocations.push({
        pharmacyId: item.pharmacyId,
        inventoryItemId: item.id,
        selectedQuantity: line.quantity,
        unitPriceMinor: item.unitPriceMinor,
        lineTotalMinor: cost,
        expiresAt,
      });
    }
    const reservation = await tx.reservation.create({
      data: {
        patientId,
        kind: "MARKETPLACE",
        requestHash,
        idempotencyKey: input.idempotencyKey,
        expiresAt,
        allocations: { create: allocations },
      },
      include: { allocations: true },
    });
    await audit(tx, patientId, "MARKETPLACE_STOCK_RESERVED", {
      reservationId: reservation.id,
      totalMinor: total,
    });
    return {
      id: reservation.id,
      expiresAt,
      allocations: reservation.allocations,
      idempotent: false,
    };
  });
}
