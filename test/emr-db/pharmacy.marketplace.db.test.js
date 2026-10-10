import { randomUUID } from "node:crypto";
import request from "supertest";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { PRIVATE_BUCKETS } from "../../src/config/privateStorage.js";
import { createFacilityOwner } from "../../src/modules/identity/identity.repository.js";
import { reserveMarketplace } from "../../src/modules/pharmacies/marketplace.reservations.js";
import { create as createOrder } from "../../src/modules/orders/orders.service.js";
import {
  release,
  create as reservePrescription,
} from "../../src/modules/reservations/reservation.service.js";
import {
  adjustStock,
  editListing,
  withdrawListing,
  renewCredentials,
} from "../../src/modules/pharmacies/portal.service.js";
import { tokenFor, prisma } from "./fixtures.js";

const expires = () => new Date(Date.now() + 365 * 86400000);
const user = async (name, role) =>
  prisma.user.create({
    data: {
      patientId: `P-${randomUUID()}`,
      email: `${randomUUID()}@pharmacy.test`,
      password: "synthetic-hash-only",
      full_name: name,
      accountStatus: "ACTIVE",
      emailVerifiedAt: new Date(),
      ...(role ? { roles: { create: { role } } } : {}),
    },
  });
let A, B, admin, security, patient, ownerA, ownerB, branchA, image;
async function pharmacy(owner, name) {
  const p = await prisma.pharmacy.create({
    data: {
      adminUserId: owner.id,
      name,
      address: "1 Synthetic Street",
      country: "Nigeria",
      state: "Lagos",
      city: "Ikeja",
      contactEmail: owner.email,
      contactPhone: "+2347000000000",
      tierLevel: 1,
      superintendentLicenceExpiresAt: expires(),
      registrationDetails: {
        cacNumber: "TEST-CAC",
        superintendentName: "Test Pharmacist",
        superintendentRegistrationNumber: "TEST-PCN",
      },
      applicationSubmittedAt: new Date(),
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
async function credential(pharmacyId, kind, branchId = null) {
  return prisma.pharmacyCredential.create({
    data: {
      pharmacyId,
      kind,
      branchId,
      contentType: "application/pdf",
      byteSize: 100,
      sha256: "a".repeat(64),
      storageBucket: PRIVATE_BUCKETS.hospitalEvidenceClean,
      storageKey: `synthetic/${randomUUID()}.pdf`,
      scanStatus: "CLEAN",
      reviewStatus: "VERIFIED",
      reviewedBy: admin.id,
      reviewedAt: new Date(),
      sourceName: "Synthetic regulator",
      reference: "TEST-ONLY",
      note: "No real document used.",
    },
  });
}
async function draft(owner, branch, extra = {}) {
  const response = await request(app)
    .post("/api/v1/pharmacy-portal/listings")
    .set("Authorization", tokenFor(owner.id))
    .send({
      branchId: branch.id,
      medicationName: `Synthetic product ${randomUUID().slice(0, 8)}`,
      availableQuantity: 5,
      unitPriceMinor: 100000,
      category: "DEVICES",
      description: "Synthetic test product, not for real sale",
      productClass: "NON_MEDICINAL",
      ...(["OTC", "PRESCRIPTION_ONLY"].includes(extra.productClass)
        ? {
            batchNumber: "SYNTHETIC-BATCH",
            expiryDate: expires().toISOString().slice(0, 10),
          }
        : {}),
      ...extra,
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data;
}
async function published(extra = {}) {
  let listing = await draft(ownerA, branchA, extra);
  const uploaded = await request(app)
    .put(`/api/v1/pharmacy-portal/listings/${listing.id}/image`)
    .set("Authorization", tokenFor(ownerA.id))
    .set("Content-Type", "image/png")
    .send(image);
  expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
  listing = uploaded.body.data;
  const submitted = await request(app)
    .post(`/api/v1/pharmacy-portal/listings/${listing.id}/submit`)
    .set("Authorization", tokenFor(ownerA.id))
    .send({ version: listing.version });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  listing = submitted.body.data;
  const approved = await request(app)
    .post(`/api/v1/platform/pharmacies/listings/${listing.id}/decision`)
    .set("Authorization", tokenFor(admin.id))
    .send({
      status: "PUBLISHED",
      version: listing.version,
      note: "Synthetic listing reviewed for integration tests.",
    });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return listing;
}
beforeAll(async () => {
  admin = await user("Test platform administrator");
  security = await user("Test security administrator");
  await prisma.platformRoleAssignment.createMany({
    data: [
      { userId: admin.id, roleCode: "SABI_PLATFORM_ADMIN" },
      { userId: security.id, roleCode: "SABI_SECURITY_ADMIN" },
    ],
  });
  patient = await user("Synthetic patient", "PATIENT");
  ownerA = await user("A owner", "PHARMACY_ADMIN");
  ownerB = await user("B owner", "PHARMACY_ADMIN");
  A = await pharmacy(ownerA, "Synthetic Pharmacy A");
  B = await pharmacy(ownerB, "Synthetic Pharmacy B");
  branchA = await prisma.pharmacyBranch.create({
    data: {
      pharmacyId: A.id,
      name: "A branch",
      address: "1 Synthetic Road",
      latitude: 6.5,
      longitude: 3.3,
      premisesLicenceNumber: "PCN-TEST",
      licenceExpiresAt: expires(),
    },
  });
  for (const kind of [
    "CAC_CERTIFICATE",
    "SUPERINTENDENT_LICENCE",
    "SUPERINTENDENT_APPOINTMENT",
  ])
    await credential(A.id, kind);
  await credential(A.id, "PREMISES_LICENCE", branchA.id);
  image = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
});

describe("pharmacy onboarding and platform oversight", () => {
  it("seeds the requested tiers exactly", async () => {
    const tiers = await prisma.pharmacyTier.findMany({
      orderBy: { level: "asc" },
    });
    expect(
      tiers.map((t) => [
        t.level,
        t.commissionBps,
        t.deliveryRadiusKm,
        t.maxBranches,
      ]),
    ).toEqual([
      [1, 1500, 5, 1],
      [2, 2000, 7, 5],
      [3, 3000, 10, null],
    ]);
  });
  it("requires authentication and isolates another pharmacy context", async () => {
    expect((await request(app).get("/api/v1/pharmacy-portal/me")).status).toBe(
      401,
    );
    expect(
      (
        await request(app)
          .get("/api/v1/pharmacy-portal/me")
          .set("Authorization", tokenFor(patient.id))
      ).status,
    ).toBe(403);
    const orgB = await prisma.identityOrganization.findUnique({
      where: { pharmacyId: B.id },
    });
    expect(
      (
        await request(app)
          .get("/api/v1/pharmacy-portal/me")
          .set("Authorization", tokenFor(ownerA.id, orgB.id))
      ).status,
    ).toBe(403);
  });
  it("enforces the single-branch cap and foreign-branch protection", async () => {
    const added = await request(app)
      .post("/api/v1/pharmacy-portal/branches")
      .set("Authorization", tokenFor(ownerA.id))
      .send({
        name: "Extra branch",
        address: "2 Synthetic Road",
        latitude: 6.5,
        longitude: 3.3,
        premisesLicenceNumber: "TEST-2",
        licenceExpiresAt: expires().toISOString(),
      });
    expect(added.status).toBe(409);
    const foreign = await request(app)
      .post("/api/v1/pharmacy-portal/listings")
      .set("Authorization", tokenFor(ownerB.id))
      .send({
        branchId: branchA.id,
        medicationName: "Forbidden item",
        availableQuantity: 1,
        unitPriceMinor: 100,
        category: "DEVICES",
        description: "Not an authorized branch",
        productClass: "NON_MEDICINAL",
      });
    expect(foreign.status).toBe(404);
  });
  it("will not approve missing credentials; passes a fully reviewed application", async () => {
    const denied = await request(app)
      .post(`/api/v1/platform/pharmacies/${B.id}/decision`)
      .set("Authorization", tokenFor(admin.id))
      .send({
        status: "VERIFIED",
        expectedStatus: "PENDING",
        tierLevel: 1,
        note: "Synthetic missing credential case",
      });
    expect(denied.status).toBe(409);
    const approved = await request(app)
      .post(`/api/v1/platform/pharmacies/${A.id}/decision`)
      .set("Authorization", tokenFor(admin.id))
      .send({
        status: "VERIFIED",
        expectedStatus: "PENDING",
        tierLevel: 1,
        note: "Synthetic regulator evidence reviewed.",
      });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(
      (await prisma.pharmacyBranch.findUnique({ where: { id: branchA.id } }))
        .status,
    ).toBe("VERIFIED");
  });
  it("directory excludes credentials, and ordinary owners cannot access it", async () => {
    expect(
      (
        await request(app)
          .get("/api/v1/platform/users")
          .set("Authorization", tokenFor(ownerA.id))
      ).status,
    ).toBe(403);
    const result = await request(app)
      .get("/api/v1/platform/users?platform=PHARMACY")
      .set("Authorization", tokenFor(admin.id));
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data.items.some((u) => u.id === ownerA.id)).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain("synthetic-hash-only");
    expect(result.body.data.items[0]).not.toHaveProperty("password");
  });
  it("blocks self-disable and last-platform-admin disable", async () => {
    const change = {
      status: "DISABLED",
      expectedStatus: "ACTIVE",
      reason: "Synthetic account status test",
    };
    expect(
      (
        await request(app)
          .patch(`/api/v1/platform/users/${admin.id}/status`)
          .set("Authorization", tokenFor(admin.id))
          .send(change)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch(`/api/v1/platform/users/${admin.id}/status`)
          .set("Authorization", tokenFor(security.id))
          .send(change)
      ).status,
    ).toBe(409);
  });
  it("suspends and restores with optimistic status checks and audited session revocation", async () => {
    const device = await prisma.authDevice.create({
      data: { userId: patient.id, label: "Synthetic device" },
    });
    const session = await prisma.authSession.create({
      data: { userId: patient.id, deviceId: device.id, expiresAt: expires() },
    });
    const changed = await request(app)
      .patch(`/api/v1/platform/users/${patient.id}/status`)
      .set("Authorization", tokenFor(admin.id))
      .send({
        status: "SUSPENDED",
        expectedStatus: "ACTIVE",
        reason: "Synthetic security review only",
      });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(
      (await prisma.authSession.findUnique({ where: { id: session.id } }))
        .revokedAt,
    ).not.toBeNull();
    expect(
      (
        await request(app)
          .patch(`/api/v1/platform/users/${patient.id}/status`)
          .set("Authorization", tokenFor(admin.id))
          .send({
            status: "ACTIVE",
            expectedStatus: "ACTIVE",
            reason: "Synthetic restore stale state",
          })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .patch(`/api/v1/platform/users/${patient.id}/status`)
          .set("Authorization", tokenFor(admin.id))
          .send({
            status: "ACTIVE",
            expectedStatus: "SUSPENDED",
            reason: "Synthetic review complete now",
          })
      ).status,
    ).toBe(200);
  });
});

describe("approved marketplace and stock holds", () => {
  it("rejects medicinal listings without a current batch and hides expired batches", async () => {
    const missing = await request(app)
      .post("/api/v1/pharmacy-portal/listings")
      .set("Authorization", tokenFor(ownerA.id))
      .send({
        branchId: branchA.id,
        medicationName: "Synthetic OTC",
        availableQuantity: 1,
        unitPriceMinor: 10000,
        category: "OTC",
        description: "A synthetic medicine used only for a test",
        productClass: "OTC",
        nafdacNumber: "TEST-REG",
      });
    expect(missing.status).toBe(400);
    const listing = await published({
      productClass: "OTC",
      category: "OTC",
      nafdacNumber: "SYNTHETIC-REG",
    });
    await prisma.pharmacyInventoryItem.update({
      where: { id: listing.inventoryItemId },
      data: { expiryDate: new Date(0) },
    });
    expect(
      (
        await request(app).get(
          `/api/v1/marketplace/products?pharmacyId=${A.id}`,
        )
      ).body.data.items.map((row) => row.id),
    ).not.toContain(listing.id);
    await expect(
      reserveMarketplace(patient.id, {
        idempotencyKey: randomUUID(),
        items: [{ listingId: listing.id, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("records stock receipts once, rejects negative balances and stale stock", async () => {
    const listing = await draft(ownerA, branchA);
    const input = {
      idempotencyKey: randomUUID(),
      expectedQuantity: 5,
      quantityDelta: 10,
      reason: "Synthetic new stock received",
    };
    const received = await adjustStock(
      ownerA.id,
      undefined,
      listing.inventoryItemId,
      input,
    );
    expect(
      (await adjustStock(ownerA.id, undefined, listing.inventoryItemId, input))
        .id,
    ).toBe(received.id);
    expect(received.balanceAfter).toBe(15);
    await expect(
      adjustStock(ownerB.id, undefined, listing.inventoryItemId, {
        ...input,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      adjustStock(ownerA.id, undefined, listing.inventoryItemId, {
        ...input,
        idempotencyKey: randomUUID(),
        expectedQuantity: 15,
        quantityDelta: -16,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      adjustStock(ownerA.id, undefined, listing.inventoryItemId, {
        ...input,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await prisma.pharmacyStockAdjustment.count({
        where: { inventoryItemId: listing.inventoryItemId },
      }),
    ).toBe(1);
  });
  it("requires a real image and excludes prescription-only public listings", async () => {
    const noImage = await draft(ownerA, branchA);
    expect(
      (
        await request(app)
          .post(`/api/v1/pharmacy-portal/listings/${noImage.id}/submit`)
          .set("Authorization", tokenFor(ownerA.id))
          .send({ version: noImage.version })
      ).status,
    ).toBe(409);
    const rx = await draft(ownerA, branchA, {
      productClass: "PRESCRIPTION_ONLY",
    });
    const imaged = await request(app)
      .put(`/api/v1/pharmacy-portal/listings/${rx.id}/image`)
      .set("Authorization", tokenFor(ownerA.id))
      .set("Content-Type", "image/png")
      .send(image);
    expect(
      (
        await request(app)
          .post(`/api/v1/pharmacy-portal/listings/${rx.id}/submit`)
          .set("Authorization", tokenFor(ownerA.id))
          .send({ version: imaged.body.data.version })
      ).status,
    ).toBe(409);
  });
  it("publishes approved items, serves images, and removes expired premises from the public feed", async () => {
    const listing = await published();
    const feed = await request(app).get(
      `/api/v1/marketplace/products?pharmacyId=${A.id}`,
    );
    expect(feed.status).toBe(200);
    expect(feed.body.data.items.map((l) => l.id)).toContain(listing.id);
    expect(
      (
        await request(app).get(
          `/api/v1/marketplace/products/${listing.id}/image`,
        )
      ).headers["content-type"],
    ).toContain("image/jpeg");
    await prisma.pharmacyBranch.update({
      where: { id: branchA.id },
      data: { licenceExpiresAt: new Date(0) },
    });
    expect(
      (
        await request(app).get(
          `/api/v1/marketplace/products?pharmacyId=${A.id}`,
        )
      ).body.data.items,
    ).toHaveLength(0);
    await prisma.pharmacyBranch.update({
      where: { id: branchA.id },
      data: { licenceExpiresAt: expires() },
    });
  });
  it("reserves once, rejects changed-cart retries and releases the hold only once", async () => {
    const listing = await published();
    const input = {
      idempotencyKey: randomUUID(),
      items: [{ listingId: listing.id, quantity: 2 }],
    };
    const first = await reserveMarketplace(patient.id, input),
      replay = await reserveMarketplace(patient.id, input);
    expect(replay.id).toBe(first.id);
    expect(
      (
        await prisma.pharmacyInventoryItem.findUnique({
          where: { id: listing.inventoryItemId },
        })
      ).availableQuantity,
    ).toBe(3);
    await expect(
      reserveMarketplace(patient.id, {
        ...input,
        items: [{ listingId: listing.id, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await release(patient.id, first.id)).toBe(true);
    expect(await release(patient.id, first.id)).toBe(false);
    expect(
      (
        await prisma.pharmacyInventoryItem.findUnique({
          where: { id: listing.inventoryItemId },
        })
      ).availableQuantity,
    ).toBe(5);
  });
  it("cannot oversell the last stock or accept client prices", async () => {
    const listing = await published({ availableQuantity: 1 });
    const another = await user("Other synthetic patient", "PATIENT");
    const outcomes = await Promise.allSettled(
      [patient.id, another.id].map((id) =>
        reserveMarketplace(id, {
          idempotencyKey: randomUUID(),
          items: [{ listingId: listing.id, quantity: 1 }],
        }),
      ),
    );
    expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const bad = await request(app)
      .post("/api/v1/marketplace/reservations")
      .set("Authorization", tokenFor(patient.id))
      .send({
        idempotencyKey: randomUUID(),
        items: [{ listingId: listing.id, quantity: 1, unitPriceMinor: 0 }],
      });
    expect(bad.status).toBe(400);
  });
  it("creates OTC pickup orders with server prices and immutable commission snapshots", async () => {
    const listing = await published();
    const hold = await reserveMarketplace(patient.id, {
      idempotencyKey: randomUUID(),
      items: [{ listingId: listing.id, quantity: 2 }],
    });
    const result = await createOrder(patient.id, {
      reservationId: hold.id,
      idempotencyKey: randomUUID(),
      fulfilments: [{ pharmacyId: A.id, fulfilmentMethod: "PICKUP" }],
    });
    expect(result.order.totalPayableMinor).toBe(200000);
    const fulfilment = await prisma.orderFulfilment.findFirst({
      where: { orderId: result.order.id },
    });
    expect(fulfilment).toMatchObject({
      commissionBps: 1500,
      commissionMinor: 30000,
      tierVersion: 1,
    });
    await prisma.pharmacyTier.update({
      where: { level: 1 },
      data: { commissionBps: 1600, version: { increment: 1 } },
    });
    expect(
      (
        await prisma.orderFulfilment.findUnique({
          where: { id: fulfilment.id },
        })
      ).commissionMinor,
    ).toBe(30000);
    await prisma.pharmacyTier.update({
      where: { level: 1 },
      data: { commissionBps: 1500, version: 1 },
    });
  });
  it("withdraws published listings and requires re-review after changing product details", async () => {
    const listing = await published();
    const current = await prisma.pharmacyListing.findUnique({
      where: { id: listing.id },
    });
    const updated = await editListing(ownerA.id, undefined, listing.id, {
      version: current.version,
      medicationName: "Updated synthetic device",
      genericName: null,
      unitPriceMinor: 200000,
      isActive: true,
      category: "DEVICES",
      description: "Revised synthetic product description",
      productClass: "NON_MEDICINAL",
      nafdacNumber: null,
      reason: "Synthetic product correction",
    });
    expect(updated.status).toBe("DRAFT");
    expect(
      (
        await request(app).get(
          `/api/v1/marketplace/products?pharmacyId=${A.id}`,
        )
      ).body.data.items.map((i) => i.id),
    ).not.toContain(listing.id);
    await expect(
      editListing(ownerA.id, undefined, listing.id, {
        version: current.version,
        reason: "Synthetic stale edit case",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await withdrawListing(ownerA.id, undefined, listing.id, updated.version))
        .status,
    ).toBe("WITHDRAWN");
  });
  it("refuses preview checkout beyond the branch radius and refuses expired superintendent licences", async () => {
    const listing = await published();
    const hold = await reserveMarketplace(patient.id, {
      idempotencyKey: randomUUID(),
      items: [{ listingId: listing.id, quantity: 1 }],
    });
    const preview = await request(app)
      .post(`/api/v1/checkout-pricing/preview/reservations/${hold.id}`)
      .set("Authorization", tokenFor(patient.id))
      .send({
        fulfilments: [{ pharmacyId: A.id, fulfilmentMethod: "DELIVERY" }],
        deliveryCoordinates: { latitude: 7.5, longitude: 3.3 },
      });
    expect(preview.status, JSON.stringify(preview.body)).toBe(400);
    await prisma.pharmacy.update({
      where: { id: A.id },
      data: { superintendentLicenceExpiresAt: new Date(0) },
    });
    expect(
      (
        await request(app).get(
          `/api/v1/marketplace/products?pharmacyId=${A.id}`,
        )
      ).body.data.items,
    ).toHaveLength(0);
    await expect(
      createOrder(patient.id, {
        reservationId: hold.id,
        idempotencyKey: randomUUID(),
        fulfilments: [{ pharmacyId: A.id, fulfilmentMethod: "PICKUP" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID" });
    await prisma.pharmacy.update({
      where: { id: A.id },
      data: { superintendentLicenceExpiresAt: expires() },
    });
    await release(patient.id, hold.id);
  });
  it("renewals require new evidence and cannot reuse previous authenticity approvals", async () => {
    const current = await prisma.pharmacyBranch.findUnique({
      where: { id: branchA.id },
    });
    const prior = await prisma.pharmacyCredential.findFirst({
      where: { pharmacyId: A.id, branchId: branchA.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const details = {
      name: current.name,
      address: current.address,
      latitude: current.latitude,
      longitude: current.longitude,
      premisesLicenceNumber: "PCN-RENEWAL-TEST",
      licenceExpiresAt: expires().toISOString(),
      version: current.version,
      reason: "Synthetic licence renewal, no real document used.",
    };
    await expect(
      renewCredentials(ownerB.id, undefined, details, branchA.id),
    ).rejects.toMatchObject({ status: 404 });
    await renewCredentials(ownerA.id, undefined, details, branchA.id);
    const changed = await prisma.pharmacy.findUnique({
      where: { id: A.id },
      include: { branches: true },
    });
    expect(changed.complianceStatus).toBe("PENDING");
    expect(changed.applicationSubmittedAt).toBeNull();
    expect(changed.branches.find((b) => b.id === branchA.id).status).toBe(
      "PENDING",
    );
    expect(
      (await prisma.pharmacyCredential.findUnique({ where: { id: prior.id } }))
        .reviewStatus,
    ).toBe("REJECTED");
    await expect(
      renewCredentials(ownerA.id, undefined, details, branchA.id),
    ).rejects.toMatchObject({ status: 409 });
    const review = await request(app)
      .post(
        `/api/v1/platform/pharmacies/${A.id}/credentials/${prior.id}/review`,
      )
      .set("Authorization", tokenFor(admin.id))
      .send({
        decision: "VERIFIED",
        sourceName: "Synthetic source",
        reference: "TEST-ONLY",
        note: "Attempting to reuse outdated evidence.",
      });
    expect(review.status).toBe(409);
    await credential(A.id, "PREMISES_LICENCE", branchA.id);
    await prisma.pharmacy.update({
      where: { id: A.id },
      data: {
        complianceStatus: "VERIFIED",
        applicationSubmittedAt: new Date(),
      },
    });
    await prisma.pharmacyBranch.update({
      where: { id: branchA.id },
      data: { status: "VERIFIED" },
    });
  });
  it("keeps clinical work separate from organization ownership, and requires verified staff acceptance", async () => {
    expect(
      (
        await request(app)
          .get(`/api/v1/pharmacy-portal/clinical/requests?pharmacyId=${A.id}`)
          .set("Authorization", tokenFor(ownerA.id))
      ).status,
    ).toBe(403);
    const pharmacist = await user(
      "Verified synthetic pharmacist",
      "PROFESSIONAL",
    );
    await prisma.professionalProfile.create({
      data: {
        userId: pharmacist.id,
        professionType: "PHARMACIST",
        registrationNumber: "SYNTHETIC-PCN",
        verificationStatus: "VERIFIED",
      },
    });
    const invited = await request(app)
      .post("/api/v1/pharmacy-portal/pharmacists/invite")
      .set("Authorization", tokenFor(ownerA.id))
      .send({ email: pharmacist.email });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    expect(
      (
        await request(app)
          .get(`/api/v1/pharmacy-portal/clinical/requests?pharmacyId=${A.id}`)
          .set("Authorization", tokenFor(pharmacist.id))
      ).status,
    ).toBe(403);
    const accepted = await request(app)
      .post(
        `/api/v1/pharmacy-portal/pharmacists/${invited.body.data.id}/accept`,
      )
      .set("Authorization", tokenFor(pharmacist.id))
      .send({});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(
      (
        await request(app)
          .get(`/api/v1/pharmacy-portal/clinical/requests?pharmacyId=${A.id}`)
          .set("Authorization", tokenFor(pharmacist.id))
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get(`/api/v1/pharmacy-portal/clinical/orders?pharmacyId=${B.id}`)
          .set("Authorization", tokenFor(pharmacist.id))
      ).status,
    ).toBe(403);
    await prisma.professionalProfile.update({
      where: { userId: pharmacist.id },
      data: { verificationStatus: "SUSPENDED" },
    });
    expect(
      (
        await request(app)
          .get(`/api/v1/pharmacy-portal/clinical/requests?pharmacyId=${A.id}`)
          .set("Authorization", tokenFor(pharmacist.id))
      ).status,
    ).toBe(403);
    const doctor = await user("Synthetic prescribing doctor", "PROFESSIONAL");
    const doctorProfile = await prisma.professionalProfile.create({
      data: {
        userId: doctor.id,
        professionType: "DOCTOR",
        registrationNumber: "SYNTHETIC-MDCN",
        verificationStatus: "VERIFIED",
      },
    });
    const medicine = await draft(ownerA, branchA, {
      medicationName: "Synthetic prescribed medicine",
      productClass: "PRESCRIPTION_ONLY",
    });
    const prescription = await prisma.prescription.create({
      data: {
        reference: `SYNTHETIC-RX-${randomUUID()}`,
        patientId: patient.id,
        doctorProfileId: doctorProfile.id,
        status: "ISSUED",
        issuedAt: new Date(),
        issuerAttestedAt: new Date(),
        items: {
          create: {
            medicationName: "Synthetic prescribed medicine",
            dosage: "Synthetic only",
            frequency: "Synthetic only",
            route: "Synthetic only",
            duration: "Synthetic only",
            quantity: 2,
            indication: "No real clinical data",
          },
        },
      },
      include: { items: true },
    });
    const prescriptionRequest = await prisma.prescriptionRequest.create({
      data: {
        prescriptionId: prescription.id,
        patientId: patient.id,
        pharmacyId: A.id,
      },
    });
    const quoteInput = {
      items: [
        {
          prescriptionItemId: prescription.items[0].id,
          inventoryItemId: medicine.inventoryItemId,
          requiredQuantity: 2,
          availableQuantity: 2,
          unitPriceMinor: 100000,
          availabilityStatus: "AVAILABLE",
          estimatedFulfilment: "Synthetic same day",
          pickupAvailable: true,
          deliveryAvailable: false,
        },
      ],
    };
    // Restore this independently verified professional for the full synthetic flow.
    await prisma.professionalProfile.update({
      where: { userId: pharmacist.id },
      data: { verificationStatus: "VERIFIED" },
    });
    const quoted = await request(app)
      .post(
        `/api/v1/pharmacy-portal/clinical/requests/${prescriptionRequest.id}/quotes?pharmacyId=${A.id}`,
      )
      .set("Authorization", tokenFor(pharmacist.id))
      .send(quoteInput);
    expect(quoted.status, JSON.stringify(quoted.body)).toBe(201);
    const quoteItem = await prisma.pharmacyQuoteItem.findFirst({
      where: { quoteId: quoted.body.data.id },
    });
    const reserved = await reservePrescription(patient.id, {
      prescriptionId: prescription.id,
      idempotencyKey: randomUUID(),
      allocations: [
        {
          prescriptionItemId: prescription.items[0].id,
          quoteItemId: quoteItem.id,
          selectedQuantity: 2,
        },
      ],
    });
    const result = await createOrder(patient.id, {
      reservationId: reserved.id,
      idempotencyKey: randomUUID(),
      fulfilments: [{ pharmacyId: A.id, fulfilmentMethod: "PICKUP" }],
    });
    const order = await prisma.order.findUnique({
      where: { id: result.order.id },
      include: { fulfilments: true },
    });
    expect(order.subtotalMinor).toBe(200000);
    expect(order.fulfilments[0].commissionMinor).toBe(30000);
    const fulfilment = order.fulfilments[0];
    const url = `/api/v1/fulfilments/${fulfilment.id}`;
    expect(
      (
        await request(app)
          .post(`${url}/decision`)
          .set("Authorization", tokenFor(pharmacist.id))
          .send({
            decision: "APPROVED_FOR_DISPENSING",
            note: "Synthetic review before payment",
          })
      ).status,
    ).toBe(404);
    // Synthetic paid state only; no provider request and no actual charge.
    await prisma.order.update({
      where: { id: order.id },
      data: { status: "PAID" },
    });
    await prisma.orderFulfilment.update({
      where: { id: fulfilment.id },
      data: { status: "AWAITING_PHARMACIST_REVIEW" },
    });
    expect(
      (
        await request(app)
          .post(`${url}/decision`)
          .set("Authorization", tokenFor(ownerA.id))
          .send({
            decision: "APPROVED_FOR_DISPENSING",
            note: "Owner cannot dispense",
          })
      ).status,
    ).toBe(404);
    await prisma.pharmacyInventoryItem.update({
      where: { id: medicine.inventoryItemId },
      data: { expiryDate: new Date(0) },
    });
    expect(
      (
        await request(app)
          .post(`${url}/decision`)
          .set("Authorization", tokenFor(pharmacist.id))
          .send({
            decision: "APPROVED_FOR_DISPENSING",
            note: "Expired stock cannot dispense",
          })
      ).status,
    ).toBe(409);
    await prisma.pharmacyInventoryItem.update({
      where: { id: medicine.inventoryItemId },
      data: { expiryDate: expires() },
    });
    const decision = await request(app)
      .post(`${url}/decision`)
      .set("Authorization", tokenFor(pharmacist.id))
      .send({
        decision: "APPROVED_FOR_DISPENSING",
        note: "Synthetic dispensing approval",
      });
    expect(decision.status, JSON.stringify(decision.body)).toBe(200);
    expect(
      (
        await request(app)
          .post(`${url}/preparation`)
          .set("Authorization", tokenFor(pharmacist.id))
          .send({ transition: "PREPARING" })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post(`${url}/preparation`)
          .set("Authorization", tokenFor(pharmacist.id))
          .send({ transition: "READY_FOR_PICKUP" })
      ).status,
    ).toBe(200);
  });
  it("gives operations staff only tenant-scoped inventory access", async () => {
    const staff = await user("Synthetic pharmacy operations staff");
    const org = await prisma.identityOrganization.findUnique({
      where: { pharmacyId: A.id },
    });
    await prisma.organizationMembership.create({
      data: {
        userId: staff.id,
        organizationId: org.id,
        status: "ACTIVE",
        roles: { create: { roleCode: "PHARMACY_STAFF" } },
      },
    });
    const read = await request(app)
      .get(`/api/v1/pharmacy-portal/staff/inventory?pharmacyId=${A.id}&page=1`)
      .set("Authorization", tokenFor(staff.id));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(read.body)).not.toContain("storageKey");
    expect(
      (
        await request(app)
          .get(`/api/v1/pharmacy-portal/staff/inventory?pharmacyId=${B.id}`)
          .set("Authorization", tokenFor(staff.id))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get(`/api/v1/pharmacy-portal/clinical/orders?pharmacyId=${A.id}`)
          .set("Authorization", tokenFor(staff.id))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get("/api/v1/pharmacy-portal/me")
          .set("Authorization", tokenFor(staff.id))
      ).status,
    ).toBe(403);
  });
});
