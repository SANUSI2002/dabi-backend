import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma, tokenFor } from "./fixtures.js";
import { createFacilityOwner } from "../../src/modules/identity/identity.repository.js";
import { encryptDeliveryDetails } from "../../src/modules/orders/orders.delivery.js";
import * as delivery from "../../src/modules/delivery/delivery.service.js";
let owner, patient, courier, stranger, pharmacy, partner;
async function user(role) {
  return prisma.user.create({
    data: {
      patientId: randomUUID(),
      email: `${randomUUID()}@handover.test`,
      password: "synthetic-only",
      accountStatus: "ACTIVE",
      emailVerifiedAt: new Date(),
      roles: { create: { role } },
    },
  });
}
beforeAll(async () => {
  process.env.ORDER_DELIVERY_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString(
    "base64",
  );
  owner = await user("PHARMACY_ADMIN");
  patient = await user("PATIENT");
  courier = await user("DELIVERY_PARTNER");
  stranger = await user("PATIENT");
  pharmacy = await prisma.pharmacy.create({
    data: {
      adminUserId: owner.id,
      name: "Synthetic handover pharmacy",
      address: "1 Test Road",
      country: "Nigeria",
      state: "Lagos",
      city: "Ikeja",
      contactEmail: owner.email,
      contactPhone: "+2347000000000",
      complianceStatus: "VERIFIED",
    },
  });
  await prisma.$transaction((tx) =>
    createFacilityOwner(tx, {
      userId: owner.id,
      pharmacyId: pharmacy.id,
      type: "PHARMACY",
      roleCode: "PHARMACY_ADMIN",
    }),
  );
  partner = await prisma.deliveryPartner.create({
    data: {
      userId: courier.id,
      displayName: "Synthetic courier",
      isActive: true,
      configuredByUserId: owner.id,
    },
  });
});
async function fixture() {
  const reservation = await prisma.reservation.create({
    data: {
      patientId: patient.id,
      kind: "MARKETPLACE",
      requestHash: "a".repeat(64),
      idempotencyKey: randomUUID(),
      status: "CONVERTED",
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  const order = await prisma.order.create({
    data: {
      patientId: patient.id,
      reservationId: reservation.id,
      reference: randomUUID(),
      idempotencyKey: randomUUID(),
      status: "PAID",
      pricingConfigVersion: 1,
      platformFeeMinor: 0,
      deliveryRatePerKmMinor: 0,
      subtotalMinor: 10000,
      deliveryFeeMinor: 0,
      totalPayableMinor: 10000,
      encryptedDeliveryDetails: encryptDeliveryDetails({
        recipientName: "Synthetic recipient",
        recipientPhone: "+2347000000000",
        address: "2 Test Road",
      }),
    },
  });
  const f = await prisma.orderFulfilment.create({
    data: {
      orderId: order.id,
      pharmacyId: pharmacy.id,
      status: "READY_FOR_PICKUP",
      fulfilmentMethod: "DELIVERY",
      inventoryFinalizedAt: new Date(),
      subtotalMinor: 10000,
      deliveryFeeMinor: 0,
      totalMinor: 10000,
    },
  });
  const a = await delivery.assign(owner.id, f.id, { partnerId: partner.id });
  await delivery.respond(courier.id, a.id);
  return { order, f, a };
}
const http = (method, path, who, body) => {
  const r = request(app)[method](`/api/v1/delivery${path}`)
    .set("Authorization", tokenFor(who.id));
  return body === undefined ? r : r.send(body);
};
describe("handover with real PostgreSQL migrations", () => {
  it('limits courier configuration to an authorized platform operator', async () => {
    const anonymous = await request(app).get('/api/v1/delivery/assignments');
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
    const operator = await user('PATIENT');
    await prisma.platformRoleAssignment.create({data:{userId:operator.id,roleCode:'SABI_PLATFORM_ADMIN'}});
    const data={displayName:'Synthetic courier',isActive:true};
    expect((await http('put',`/platform/partners/${courier.id}`,patient,data)).status).toBe(403);
    expect((await http('put',`/platform/partners/${courier.id}`,owner,data)).status).toBe(403);
    expect((await http('put',`/platform/partners/${courier.id}`,operator,data)).status).toBe(200);
    expect((await prisma.deliveryPartner.findUnique({where:{id:partner.id}})).configuredByUserId).toBe(operator.id);
  });
  it("completes pickup and delivery through HTTP with distinct holder codes and no payment mutation", async () => {
    const { order, f, a } = await fixture();
    const pickup = await http("get", `/fulfilments/${f.id}/pickup-code`, owner);
    expect(pickup.status).toBe(200);
    expect(pickup.headers["cache-control"]).toBe("no-store");
    const code = pickup.body.data.code;
    expect(
      (await http("get", `/fulfilments/${f.id}/pickup-code`, courier)).status,
    ).toBe(403);
    expect(
      (await http("get", `/orders/${order.id}/delivery-codes`, stranger))
        .status,
    ).toBe(404);
    expect(
      (
        await http("post", `/assignments/${a.id}/status`, courier, {
          status: "PICKED_UP",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await http("post", `/assignments/${a.id}/status`, courier, {
          status: "PICKED_UP",
          code,
        })
      ).status,
    ).toBe(200);
    const receipt = (
      await http("get", `/orders/${order.id}/delivery-codes`, patient)
    ).body.data[0].code;
    expect(receipt).not.toBe(code);
    await delivery.transition(courier.id, a.id, { status: "OUT_FOR_DELIVERY" });
    await delivery.transition(courier.id, a.id, {
      status: "DELIVERED",
      code: receipt,
    });
    const saved = await prisma.deliveryAssignment.findUnique({
      where: { id: a.id },
    });
    expect(saved.status).toBe("COMPLETED");
    expect(saved.pickupCodeEncrypted).toBeNull();
    expect(saved.deliveryCodeEncrypted).toBeNull();
    expect(saved.pickedUpAt).toBeInstanceOf(Date);
    expect(saved.deliveredAt).toBeInstanceOf(Date);
    expect(
      (await prisma.order.findUnique({ where: { id: order.id } })).status,
    ).toBe("PAID");
    await expect(
      delivery.transition(courier.id, a.id, {
        status: "DELIVERED",
        code: receipt,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("persists rejected guesses after the HTTP error and prevents lock reset through reissue", async () => {
    const { f, a } = await fixture(),
      proof = await delivery.pickupCode(owner.id, f.id);
    const wrong = proof.code === "000000" ? "111111" : "000000";
    for (let i = 1; i <= 5; i++) {
      const r = await http("post", `/assignments/${a.id}/status`, courier, {
        status: "PICKED_UP",
        code: wrong,
      });
      expect(r.status).toBe(i < 5 ? 400 : 429);
      expect(
        (await prisma.deliveryAssignment.findUnique({ where: { id: a.id } }))
          .pickupCodeAttempts,
      ).toBe(i);
    }
    await prisma.deliveryAssignment.update({
      where: { id: a.id },
      data: { pickupCodeIssuedAt: new Date(Date.now() - 61000) },
    });
    const replacement = await delivery.pickupCode(owner.id, f.id, true);
    await expect(
      delivery.transition(courier.id, a.id, {
        status: "PICKED_UP",
        code: replacement.code,
      }),
    ).rejects.toMatchObject({ code: "CODE_LOCKED" });
    expect(
      (await prisma.orderFulfilment.findUnique({ where: { id: f.id } })).status,
    ).toBe("READY_FOR_PICKUP");
  });
  it("serializes replay races with one successful consumption and revokes suspended memberships", async () => {
    const { f, a } = await fixture(),
      proof = await delivery.pickupCode(owner.id, f.id);
    const results = await Promise.allSettled([
      delivery.transition(courier.id, a.id, {
        status: "PICKED_UP",
        code: proof.code,
      }),
      delivery.transition(courier.id, a.id, {
        status: "PICKED_UP",
        code: proof.code,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await prisma.activityLog.findMany({
        where: {
          type: "DELIVERY_PICKED_UP",
          meta: { path: ["id"], equals: a.id },
        },
      }),
    ).toHaveLength(1);
    const membership = await prisma.organizationMembership.findFirst({
      where: { userId: owner.id },
    });
    await prisma.organizationMembership.update({
      where: { id: membership.id },
      data: { status: "SUSPENDED" },
    });
    await expect(delivery.pickupCode(owner.id, f.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await prisma.organizationMembership.update({
      where: { id: membership.id },
      data: { status: "ACTIVE" },
    });
  });
});
