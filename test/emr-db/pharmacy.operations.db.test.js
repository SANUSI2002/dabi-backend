import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { createFacilityOwner } from "../../src/modules/identity/identity.repository.js";
import {
  enqueuePharmacyEmail,
  queueLicenceReminders,
} from "../../src/modules/pharmacies/portal.email.js";
import { prisma, tokenFor } from "./fixtures.js";
let a, b, ownerA, ownerB, branch, stock, patient, admin;
const future = () => new Date(Date.now() + 365 * 86400000);
async function user(role = "PHARMACY_ADMIN") {
  return prisma.user.create({
    data: {
      patientId: `OPS-${randomUUID()}`,
      email: `${randomUUID()}@pharmacy.test`,
      password: "synthetic-not-a-password",
      full_name: "Synthetic account",
      accountStatus: "ACTIVE",
      emailVerifiedAt: new Date(),
      roles: { create: { role } },
    },
  });
}
async function pharmacy(owner) {
  const p = await prisma.pharmacy.create({
    data: {
      adminUserId: owner.id,
      name: `Synthetic pharmacy ${randomUUID().slice(0, 6)}`,
      address: "1 Test Street",
      country: "Nigeria",
      state: "Lagos",
      city: "Ikeja",
      contactEmail: owner.email,
      contactPhone: "+2347000000000",
      tierLevel: 1,
      complianceStatus: "VERIFIED",
      superintendentLicenceExpiresAt: future(),
    },
  });
  await prisma.$transaction((tx) =>
    createFacilityOwner(tx, {
      userId: owner.id,
      pharmacyId: p.id,
      type: "PHARMACY",
      roleCode: "PHARMACY_ADMIN",
    }),
  );
  return p;
}
beforeAll(async () => {
  ownerA = await user();
  ownerB = await user();
  patient = await user("PATIENT");
  admin = await user();
  await prisma.platformRoleAssignment.create({
    data: { userId: admin.id, roleCode: "SABI_PLATFORM_ADMIN" },
  });
  a = await pharmacy(ownerA);
  b = await pharmacy(ownerB);
  branch = await prisma.pharmacyBranch.create({
    data: {
      pharmacyId: a.id,
      name: "Synthetic branch",
      address: "1 Test Street",
      latitude: 6.5,
      longitude: 3.3,
      premisesLicenceNumber: "TEST-PCN",
      licenceExpiresAt: future(),
      status: "VERIFIED",
    },
  });
  stock = await prisma.pharmacyInventoryItem.create({
    data: {
      pharmacyId: a.id,
      branchId: branch.id,
      medicationName: "Synthetic device",
      availableQuantity: 2,
      unitPriceMinor: 10000,
      reorderPoint: 3,
      reorderTarget: 10,
      batchNumber: "TEST-BATCH",
      expiryDate: future(),
    },
  });
  await prisma.pharmacyInventoryItem.create({
    data: {
      pharmacyId: b.id,
      medicationName: "Foreign stock must not appear",
      availableQuantity: 999,
      unitPriceMinor: 999999,
    },
  });
});
const get = (path, who = ownerA) =>
  request(app)
    .get(`/api/v1/pharmacy-portal${path}`)
    .set("Authorization", tokenFor(who.id));
describe("pharmacy operations database boundaries", () => {
  it("requires authentication and forbids foreign-branch reports and patient stock access", async () => {
    expect(
      (await request(app).get("/api/v1/pharmacy-portal/stock")).status,
    ).toBe(401);
    expect((await get("/stock", patient)).status).toBe(403);
    expect((await get(`/stock?branchId=${branch.id}`, ownerB)).status).toBe(
      404,
    );
    const result = await get("/stock?state=LOW");
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data.summary).toMatchObject({
      batchCount: 1,
      availableUnits: 2,
      retailValueMinor: 20000,
      lowStockBatches: 1,
    });
    expect(result.body.data.items[0]).toMatchObject({
      id: stock.id,
      suggestedReorderQuantity: 8,
      reservedUnits: 0,
      orderAllocatedUnits: 0,
    });
    expect(JSON.stringify(result.body)).not.toContain("Foreign stock");
  });
  it("updates reorder policies with tenant scope, reason, version and target validation", async () => {
    const path = `/api/v1/pharmacy-portal/inventory/${stock.id}/reorder-policy`,
      payload = {
        reorderPoint: 4,
        reorderTarget: 15,
        version: 1,
        reason: "Synthetic replenishment policy",
      };
    expect(
      (
        await request(app)
          .patch(path)
          .set("Authorization", tokenFor(ownerB.id))
          .send(payload)
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .patch(path)
          .set("Authorization", tokenFor(ownerA.id))
          .send({ ...payload, reorderTarget: 1 })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .patch(path)
          .set("Authorization", tokenFor(ownerA.id))
          .send(payload)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .patch(path)
          .set("Authorization", tokenFor(ownerA.id))
          .send(payload)
      ).status,
    ).toBe(409);
    expect(
      await prisma.activityLog.count({
        where: { userId: ownerA.id, type: "PHARMACY_REORDER_POLICY_CHANGED" },
      }),
    ).toBe(1);
  });
  it("exports safe pharmacy stock CSV and pages immutable adjustments without foreign history", async () => {
    const csv = await get("/stock/export");
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["cache-control"]).toBe("no-store");
    expect(csv.text).toContain("Synthetic device");
    expect(csv.text).not.toContain("Foreign stock");
    await prisma.pharmacyStockAdjustment.create({
      data: {
        inventoryItemId: stock.id,
        idempotencyKey: randomUUID(),
        requestHash: "a".repeat(64),
        quantityDelta: 1,
        balanceBefore: 1,
        balanceAfter: 2,
        actorId: ownerA.id,
        reason: "Synthetic stock receipt",
      },
    });
    expect(
      (await get(`/inventory/${stock.id}/adjustments`, ownerB)).status,
    ).toBe(404);
    const history = await get(`/inventory/${stock.id}/adjustments`);
    expect(history.body.data.items[0]).toMatchObject({
      quantityDelta: 1,
      balanceBefore: 1,
      balanceAfter: 2,
    });
    expect(history.body.data.items[0].actorId).toBeUndefined();
  });
  async function paidOrder(p, item, successful = true) {
    const reservation = await prisma.reservation.create({
      data: {
        patientId: patient.id,
        kind: "MARKETPLACE",
        requestHash: "a".repeat(64),
        idempotencyKey: randomUUID(),
        status: "CONVERTED",
        expiresAt: future(),
      },
    });
    const allocation = await prisma.reservationAllocation.create({
      data: {
        reservationId: reservation.id,
        pharmacyId: p.id,
        inventoryItemId: item.id,
        selectedQuantity: 2,
        unitPriceMinor: 10000,
        lineTotalMinor: 20000,
        expiresAt: future(),
      },
    });
    const o = await prisma.order.create({
      data: {
        reference: `OPS-${randomUUID()}`,
        patientId: patient.id,
        reservationId: reservation.id,
        idempotencyKey: randomUUID(),
        status: successful ? "PAID" : "PENDING_PAYMENT",
        currency: "NGN",
        pricingConfigVersion: 1,
        platformFeeMinor: 0,
        deliveryRatePerKmMinor: 0,
        subtotalMinor: 20000,
        deliveryFeeMinor: 1000,
        totalPayableMinor: 21000,
      },
    });
    const f = await prisma.orderFulfilment.create({
      data: {
        orderId: o.id,
        pharmacyId: p.id,
        status: "PREPARING",
        fulfilmentMethod: "PICKUP",
        subtotalMinor: 20000,
        deliveryFeeMinor: 1000,
        totalMinor: 21000,
        commissionBps: 1500,
        commissionMinor: 3000,
        tierVersion: 1,
      },
    });
    await prisma.orderAllocation.create({
      data: {
        fulfilmentId: f.id,
        reservationAllocationId: allocation.id,
        inventoryItemId: item.id,
        medicationName: item.medicationName,
        selectedQuantity: 2,
        unitPriceMinor: 10000,
        lineTotalMinor: 20000,
      },
    });
    if (successful)
      await prisma.paymentAttempt.create({
        data: {
          orderId: o.id,
          provider: "SYNTHETIC",
          idempotencyKey: randomUUID(),
          providerReference: randomUUID(),
          status: "SUCCESS",
          amountMinor: 21000,
          currency: "NGN",
          expiresAt: future(),
          completedAt: new Date('2026-10-09T23:30:00Z'),
        },
      });
    return f;
  }
  it("counts only confirmed paid sales, snapshots commission, separates refund review and never exposes patient data", async () => {
    const f = await paidOrder(a, stock);
    await paidOrder(a, stock, false);
    await prisma.refundReviewCase.create({
      data: {
        fulfilmentId: f.id,
        orderId: f.orderId,
        amountMinor: 1000,
        currency: "NGN",
        reason: "Synthetic refund review",
      },
    });
    // Two successful provider records must not duplicate a fulfilment or move
    // its first paid date. 23:30 UTC belongs to the next Lagos calendar day.
    await prisma.paymentAttempt.create({ data: { orderId: f.orderId, provider: 'SYNTHETIC', idempotencyKey: randomUUID(), providerReference: randomUUID(), status: 'SUCCESS', amountMinor: 21000, currency: 'NGN', expiresAt: future(), completedAt: new Date('2026-10-11T10:00:00Z') } });
    const today = '2026-10-10',
      path = `/reports/sales?from=${today}&to=${today}&branchId=${branch.id}`;
    const r = await get(path);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.summary).toMatchObject({
      paidFulfilments: 1,
      productSubtotalMinor: 20000,
      commissionMinor: 3000,
      productNetBeforeRefundsMinor: 17000,
      deliveryFeesMinor: 1000,
      refundReviewMinor: 1000,
    });
    expect(r.body.data.items).toHaveLength(1);
    expect(r.body.data.daily[0]).toMatchObject({ day: today, paidFulfilments: 1, productSubtotalMinor: 20000 });
    expect(JSON.stringify(r.body)).not.toContain(patient.email);
    expect(JSON.stringify(r.body)).not.toContain("encryptedDelivery");
    expect(
      (await get(`/reports/sales/export?from=${today}&to=${today}`)).text,
    ).toContain("Commission kobo");
    expect((await get(path, ownerB)).status).toBe(404);
    expect(
      (await get("/reports/sales?from=2026-02-31&to=2026-03-03")).status,
    ).toBe(400);
  });
  it("commits rejection and its email together without revealing review notes in email", async () => {
    const p = await pharmacy(await user());
    await prisma.pharmacy.update({
      where: { id: p.id },
      data: { complianceStatus: "PENDING" },
    });
    const result = await request(app)
      .post(`/api/v1/platform/pharmacies/${p.id}/decision`)
      .set("Authorization", tokenFor(admin.id))
      .send({
        status: "REJECTED",
        expectedStatus: "PENDING",
        tierLevel: 1,
        note: "Synthetic confidential operations note",
      });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const jobs = await prisma.pharmacyEmailJob.findMany({
      where: { pharmacyId: p.id },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      status: "QUEUED",
      expectedStatus: "REJECTED",
    });
    expect(jobs[0].text).not.toContain("confidential operations note");
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueuePharmacyEmail(
          tx,
          { ...p, admin: { email: "synthetic@pharmacy.test" } },
          {
            eventKey: "rollback-test",
            kind: "TEST",
            subject: "Test",
            message: "Synthetic message",
          },
        );
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(
      await prisma.pharmacyEmailJob.count({
        where: { eventKey: "rollback-test" },
      }),
    ).toBe(0);
  });
  it("deduplicates reminder stages and hides another pharmacy communication history", async () => {
    const now = new Date();
    await prisma.pharmacyBranch.update({
      where: { id: branch.id },
      data: { licenceExpiresAt: new Date(now.getTime() + 6 * 86400000) },
    });
    await queueLicenceReminders({ db: prisma, now });
    await queueLicenceReminders({ db: prisma, now });
    const jobs = await prisma.pharmacyEmailJob.findMany({
      where: { pharmacyId: a.id, kind: "LICENCE_EXPIRY" },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].subject).toContain("7 days");
    const history = await get("/communications");
    expect(history.body.data.items).toHaveLength(1);
    expect(history.body.data.items[0].recipient).toBeUndefined();
    expect(history.body.data.items[0].text).toBeUndefined();
    expect((await get("/communications", ownerB)).body.data.items).toHaveLength(
      0,
    );
  });
});
