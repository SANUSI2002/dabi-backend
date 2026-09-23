import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fn = () => vi.fn();
const tx = {
  checkoutPricingConfiguration: { findFirst: fn(), create: fn() },
};
const prisma = {
  checkoutPricingConfiguration: { findFirst: fn() },
  reservation: { findFirst: fn() },
  userRole: { findFirst: fn() },
  $transaction: fn(),
};

vi.mock('../src/config/db.js', () => ({ default: prisma }));

const { default: routes } = await import('../src/modules/checkout-pricing/checkout-pricing.routes.js');

process.env.JWT_SECRET = 'checkout-pricing-test-secret';

const adminId = '11111111-1111-4111-8111-111111111111';
const patientId = '22222222-2222-4222-8222-222222222222';
const otherPatientId = '33333333-3333-4333-8333-333333333333';
const reservationId = '44444444-4444-4444-8444-444444444444';
const pharmacyOneId = '55555555-5555-4555-8555-555555555555';
const pharmacyTwoId = '66666666-6666-4666-8666-666666666666';

const auth = (id, expiresIn) => ({
  Authorization: `Bearer ${jwt.sign(
    { userId: id },
    process.env.JWT_SECRET,
    expiresIn ? { expiresIn } : undefined,
  )}`,
});

const pricing = {
  id: '77777777-7777-4777-8777-777777777777',
  version: 1,
  platformFeeMinor: 0,
  deliveryRatePerKmMinor: 60000,
  currency: 'NGN',
  effectiveAt: new Date('2026-09-13T12:00:00.000Z'),
  createdAt: new Date('2026-09-13T12:00:00.000Z'),
};

const reservation = {
  id: reservationId,
  status: 'ACTIVE',
  expiresAt: new Date('2026-09-13T12:20:00.000Z'),
  allocations: [
    {
      pharmacyId: pharmacyOneId,
      lineTotalMinor: 15000,
      pharmacy: {
        id: pharmacyOneId,
        name: 'Pickup Pharmacy',
        address: '1 Safe Street',
        country: 'Nigeria',
        state: 'Lagos',
        city: 'Ikeja',
        latitude: 6.5244,
        longitude: 3.3792,
        complianceStatus: 'VERIFIED',
      },
      quoteItem: { pickupAvailable: true, deliveryAvailable: true },
    },
    {
      pharmacyId: pharmacyTwoId,
      lineTotalMinor: 20000,
      pharmacy: {
        id: pharmacyTwoId,
        name: 'Delivery Pharmacy',
        address: '2 Safe Street',
        country: 'Nigeria',
        state: 'Lagos',
        city: 'Ikeja',
        latitude: 6.5000,
        longitude: 3.4000,
        complianceStatus: 'VERIFIED',
      },
      quoteItem: { pickupAvailable: true, deliveryAvailable: true },
    },
  ],
};

const app = express();
app.use(express.json());
app.use('/checkout-pricing', routes);

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation((callback) => callback(tx));
  prisma.userRole.findFirst.mockImplementation(({ where }) => {
    if (where.role === 'SUPER_ADMIN' && where.userId === adminId) return Promise.resolve({ id: 'admin-role' });
    if (where.role === 'PATIENT' && where.userId === patientId) return Promise.resolve({ id: 'patient-role' });
    return Promise.resolve(null);
  });
  prisma.checkoutPricingConfiguration.findFirst.mockResolvedValue(pricing);
  tx.checkoutPricingConfiguration.findFirst.mockResolvedValue({ version: 1 });
  tx.checkoutPricingConfiguration.create.mockResolvedValue({ ...pricing, version: 2, platformFeeMinor: 5000 });
  prisma.reservation.findFirst.mockResolvedValue(reservation);
});

describe('checkout pricing routes', () => {
  it('allows only a Super Admin to view and version pricing configuration', async () => {
    const current = await request(app).get('/checkout-pricing/admin').set(auth(adminId));
    const updated = await request(app)
      .put('/checkout-pricing/admin')
      .set(auth(adminId))
      .send({ platformFeeMinor: 5000, deliveryRatePerKmMinor: 60000, currency: 'NGN' });
    const denied = await request(app).get('/checkout-pricing/admin').set(auth(patientId));

    expect(current.status).toBe(200);
    expect(current.body.data).toMatchObject({ version: 1, currency: 'NGN', platformFeeMinor: 0 });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ version: 2, platformFeeMinor: 5000 });
    expect(tx.checkoutPricingConfiguration.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ version: 2, createdByUserId: adminId }),
    }));
    expect(denied.status).toBe(403);
  });

  it('calculates pharmacy subtotals and delivery fees from reservation snapshots', async () => {
    const response = await request(app)
      .post(`/checkout-pricing/preview/reservations/${reservationId}`)
      .set(auth(patientId))
      .send({
        fulfilments: [
          { pharmacyId: pharmacyOneId, fulfilmentMethod: 'PICKUP' },
          { pharmacyId: pharmacyTwoId, fulfilmentMethod: 'DELIVERY' },
        ],
        deliveryCoordinates: { latitude: 6.51, longitude: 3.39 },
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      reservationId,
      currency: 'NGN',
      subtotalMinor: 35000,
      platformFeeMinor: 0,
      pricingConfiguration: { version: 1, deliveryRatePerKmMinor: 60000 },
    });
    expect(response.body.data.pharmacies[0]).toMatchObject({
      fulfilmentMethod: 'PICKUP',
      subtotalMinor: 15000,
      deliveryFeeMinor: 0,
      distanceKm: null,
    });
    expect(response.body.data.pharmacies[1].deliveryFeeMinor).toBeGreaterThan(0);
    expect(Number.isInteger(response.body.data.pharmacies[1].deliveryFeeMinor)).toBe(true);
    expect(response.body.data.totalPayableMinor).toBe(
      35000 + response.body.data.deliveryFeeMinor,
    );
    expect(JSON.stringify(response.body)).not.toContain('inventoryItemId');
    expect(JSON.stringify(response.body)).not.toContain('availableQuantity');
    expect(JSON.stringify(response.body)).not.toContain('quoteItemId');
  });

  it('rejects non-patients, non-owned reservations, unsupported delivery, and malformed input safely', async () => {
    expect((await request(app)
      .post(`/checkout-pricing/preview/reservations/${reservationId}`)
      .set(auth(otherPatientId))
      .send({ fulfilments: [{ pharmacyId: pharmacyOneId, fulfilmentMethod: 'PICKUP' }], })).status).toBe(403);

    prisma.reservation.findFirst.mockResolvedValueOnce(null);
    expect((await request(app)
      .post(`/checkout-pricing/preview/reservations/${reservationId}`)
      .set(auth(patientId))
      .send({ fulfilments: [{ pharmacyId: pharmacyOneId, fulfilmentMethod: 'PICKUP' }], })).status).toBe(404);

    expect((await request(app)
      .post('/checkout-pricing/preview/reservations/not-a-uuid')
      .set(auth(patientId))
      .send({ fulfilments: [] })).status).toBe(400);
    expect((await request(app)
      .post(`/checkout-pricing/preview/reservations/${reservationId}`)
      .set(auth(patientId))
      .send({ fulfilments: [{ pharmacyId: pharmacyOneId, fulfilmentMethod: 'DELIVERY' }] })).status).toBe(400);

    reservation.allocations[1].quoteItem.deliveryAvailable = false;
    const unsupported = await request(app)
      .post(`/checkout-pricing/preview/reservations/${reservationId}`)
      .set(auth(patientId))
      .send({
        fulfilments: [
          { pharmacyId: pharmacyOneId, fulfilmentMethod: 'PICKUP' },
          { pharmacyId: pharmacyTwoId, fulfilmentMethod: 'DELIVERY' },
        ],
        deliveryCoordinates: { latitude: 6.51, longitude: 3.39 },
      });
    expect(unsupported.status).toBe(400);
    reservation.allocations[1].quoteItem.deliveryAvailable = true;

    reservation.allocations[1].pharmacy.latitude = null;
    const missingCoordinates = await request(app)
      .post(`/checkout-pricing/preview/reservations/${reservationId}`)
      .set(auth(patientId))
      .send({
        fulfilments: [
          { pharmacyId: pharmacyOneId, fulfilmentMethod: 'PICKUP' },
          { pharmacyId: pharmacyTwoId, fulfilmentMethod: 'DELIVERY' },
        ],
        deliveryCoordinates: { latitude: 6.51, longitude: 3.39 },
      });
    expect(missingCoordinates.status).toBe(400);
    reservation.allocations[1].pharmacy.latitude = 6.5;
  });

  it('rejects token failures and uses the safe module error contract for database failures', async () => {
    expect((await request(app).get('/checkout-pricing/admin')).status).toBe(401);
    expect((await request(app).get('/checkout-pricing/admin').set('Authorization', 'Bearer malformed')).status).toBe(401);
    expect((await request(app).get('/checkout-pricing/admin').set(auth(adminId, '-1s'))).status).toBe(401);

    prisma.checkoutPricingConfiguration.findFirst.mockRejectedValueOnce(new Error('database secret'));
    const failure = await request(app).get('/checkout-pricing/admin').set(auth(adminId));
    expect(failure.status).toBe(500);
    expect(failure.body).toEqual({
      status: 'error',
      message: 'Checkout pricing module temporarily unavailable',
    });
    expect(failure.text).not.toContain('database secret');
  });
});
