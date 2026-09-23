import express from 'express';
import { Buffer } from 'node:buffer';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fn = () => vi.fn();
const tx = {
  userRole: { findFirst: fn() },
  order: { findFirst: fn(), create: fn() },
  reservation: { findFirst: fn(), updateMany: fn() },
  checkoutPricingConfiguration: { findFirst: fn() },
  activityLog: { create: fn() },
};
const prisma = {
  userRole: { findFirst: fn() },
  order: { findFirst: fn(), findMany: fn() },
  $transaction: fn(),
};

vi.mock('../src/config/db.js', () => ({ default: prisma }));

const { default: routes } = await import('../src/modules/orders/orders.routes.js');

process.env.JWT_SECRET = 'orders-route-test-secret';

const patientId = '11111111-1111-4111-8111-111111111111';
const otherPatientId = '22222222-2222-4222-8222-222222222222';
const doctorId = '33333333-3333-4333-8333-333333333333';
const reservationId = '44444444-4444-4444-8444-444444444444';
const pharmacyOneId = '55555555-5555-4555-8555-555555555555';
const pharmacyTwoId = '66666666-6666-4666-8666-666666666666';
const allocationOneId = '77777777-7777-4777-8777-777777777777';
const allocationTwoId = '88888888-8888-4888-8888-888888888888';
const prescriptionOneId = '99999999-9999-4999-8999-999999999999';
const prescriptionTwoId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const auth = (id, expiresIn) => ({
  Authorization: `Bearer ${jwt.sign(
    { userId: id },
    process.env.JWT_SECRET,
    expiresIn ? { expiresIn } : undefined,
  )}`,
});

const orderBody = {
  reservationId,
  idempotencyKey: 'checkout-order-idempotency-001',
  fulfilments: [
    { pharmacyId: pharmacyOneId, fulfilmentMethod: 'PICKUP' },
    { pharmacyId: pharmacyTwoId, fulfilmentMethod: 'DELIVERY' },
  ],
  delivery: {
    recipientName: 'Ada Patient',
    recipientPhone: '+2348012345678',
    address: '1 Private Address, Ikeja, Lagos',
    coordinates: { latitude: 6.51, longitude: 3.39 },
  },
};

const reservation = {
  id: reservationId,
  prescription: {
    items: [
      { id: prescriptionOneId, medicationName: 'Amoxicillin' },
      { id: prescriptionTwoId, medicationName: 'Paracetamol' },
    ],
  },
  allocations: [
    {
      id: allocationOneId,
      pharmacyId: pharmacyOneId,
      prescriptionItemId: prescriptionOneId,
      selectedQuantity: 2,
      unitPriceMinor: 5000,
      lineTotalMinor: 10000,
      pharmacy: {
        id: pharmacyOneId, name: 'Pickup Pharmacy', address: '1 Safe Street', country: 'Nigeria',
        state: 'Lagos', city: 'Ikeja', latitude: 6.5244, longitude: 3.3792, complianceStatus: 'VERIFIED',
      },
      inventoryItem: { id: 'b1111111-1111-4111-8111-111111111111', pharmacyId: pharmacyOneId, isActive: true },
      quoteItem: { pickupAvailable: true, deliveryAvailable: true },
    },
    {
      id: allocationTwoId,
      pharmacyId: pharmacyTwoId,
      prescriptionItemId: prescriptionTwoId,
      selectedQuantity: 1,
      unitPriceMinor: 12000,
      lineTotalMinor: 12000,
      pharmacy: {
        id: pharmacyTwoId, name: 'Delivery Pharmacy', address: '2 Safe Street', country: 'Nigeria',
        state: 'Lagos', city: 'Ikeja', latitude: 6.5, longitude: 3.4, complianceStatus: 'VERIFIED',
      },
      inventoryItem: { id: 'c1111111-1111-4111-8111-111111111111', pharmacyId: pharmacyTwoId, isActive: true },
      quoteItem: { pickupAvailable: true, deliveryAvailable: true },
    },
  ],
};

const createdOrder = {
  id: 'd1111111-1111-4111-8111-111111111111',
  reference: 'SH-TESTORDER',
  patientId,
  reservationId,
  idempotencyKey: orderBody.idempotencyKey,
  status: 'PENDING_PAYMENT',
  currency: 'NGN',
  pricingConfigVersion: 4,
  platformFeeMinor: 1500,
  deliveryRatePerKmMinor: 60000,
  subtotalMinor: 22000,
  deliveryFeeMinor: 1000,
  totalPayableMinor: 24500,
  encryptedDeliveryDetails: 'v1.encrypted.delivery',
  createdAt: new Date('2026-09-13T12:00:00.000Z'),
  fulfilments: [
    {
      id: 'e1111111-1111-4111-8111-111111111111', status: 'AWAITING_PAYMENT', fulfilmentMethod: 'PICKUP',
      subtotalMinor: 10000, deliveryFeeMinor: 0, totalMinor: 10000,
      pharmacy: { id: pharmacyOneId, name: 'Pickup Pharmacy', address: '1 Safe Street', country: 'Nigeria', state: 'Lagos', city: 'Ikeja' },
      allocations: [{ prescriptionItemId: prescriptionOneId, medicationName: 'Amoxicillin', selectedQuantity: 2, unitPriceMinor: 5000, lineTotalMinor: 10000 }],
    },
    {
      id: 'f1111111-1111-4111-8111-111111111111', status: 'AWAITING_PAYMENT', fulfilmentMethod: 'DELIVERY',
      subtotalMinor: 12000, deliveryFeeMinor: 1000, totalMinor: 13000,
      pharmacy: { id: pharmacyTwoId, name: 'Delivery Pharmacy', address: '2 Safe Street', country: 'Nigeria', state: 'Lagos', city: 'Ikeja' },
      allocations: [{ prescriptionItemId: prescriptionTwoId, medicationName: 'Paracetamol', selectedQuantity: 1, unitPriceMinor: 12000, lineTotalMinor: 12000 }],
    },
  ],
};

const app = express();
app.use(express.json());
app.use('/orders', routes);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ORDER_DELIVERY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  prisma.$transaction.mockImplementation((callback) => callback(tx));
  tx.userRole.findFirst.mockImplementation(({ where }) => Promise.resolve(
    where.role === 'PATIENT' && where.userId !== doctorId ? { id: 'patient-role' } : null,
  ));
  prisma.userRole.findFirst.mockImplementation(({ where }) => Promise.resolve(
    where.role === 'PATIENT' && where.userId !== doctorId ? { id: 'patient-role' } : null,
  ));
  tx.order.findFirst.mockResolvedValue(null);
  tx.reservation.findFirst.mockResolvedValue(reservation);
  tx.checkoutPricingConfiguration.findFirst.mockResolvedValue({
    version: 4, platformFeeMinor: 1500, deliveryRatePerKmMinor: 60000, currency: 'NGN',
  });
  tx.reservation.updateMany.mockResolvedValue({ count: 1 });
  tx.order.create.mockResolvedValue(createdOrder);
  tx.activityLog.create.mockResolvedValue({});
  prisma.order.findFirst.mockResolvedValue(createdOrder);
  prisma.order.findMany.mockResolvedValue([createdOrder]);
});

describe('orders routes', () => {
  it('creates one multi-pharmacy pending-payment order with immutable snapshots', async () => {
    const response = await request(app).post('/orders').set(auth(patientId)).send(orderBody);

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      reference: 'SH-TESTORDER', status: 'PENDING_PAYMENT', pricingConfigVersion: 4,
      platformFeeMinor: 1500, deliveryDetailsPresent: true,
    });
    expect(response.body.data.fulfilments).toHaveLength(2);
    expect(response.body.data.fulfilments[0]).toMatchObject({
      status: 'AWAITING_PAYMENT', fulfilmentMethod: 'PICKUP', deliveryFeeMinor: 0,
    });
    const payload = tx.order.create.mock.calls[0][0].data;
    expect(payload).toMatchObject({
      status: 'PENDING_PAYMENT', reservationId, pricingConfigVersion: 4, platformFeeMinor: 1500,
    });
    expect(payload.encryptedDeliveryDetails).toMatch(/^v1\./);
    expect(payload.encryptedDeliveryDetails).not.toContain('Ada Patient');
    expect(payload.fulfilments.create[0].allocations.create[0]).toMatchObject({
      reservationAllocationId: allocationOneId, medicationName: 'Amoxicillin', lineTotalMinor: 10000,
    });
    expect(JSON.stringify(response.body)).not.toContain('encryptedDeliveryDetails');
    expect(JSON.stringify(response.body)).not.toContain('inventoryItemId');
  });

  it('returns the same order for an idempotent reservation retry without conversion or a second write', async () => {
    tx.order.findFirst.mockResolvedValueOnce(createdOrder);
    const response = await request(app).post('/orders').set(auth(patientId)).send(orderBody);

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(createdOrder.id);
    expect(tx.reservation.updateMany).not.toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('returns only patient-owned orders and rejects cross-user and non-patient reads', async () => {
    const list = await request(app).get('/orders').set(auth(patientId));
    const detail = await request(app).get(`/orders/${createdOrder.id}`).set(auth(patientId));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(detail.status).toBe(200);

    prisma.order.findFirst.mockResolvedValueOnce(null);
    const crossUser = await request(app).get(`/orders/${createdOrder.id}`).set(auth(otherPatientId));
    const doctor = await request(app).get('/orders').set(auth(doctorId));
    expect(crossUser.status).toBe(404);
    expect(doctor.status).toBe(403);
  });

  it('rejects encryption-free delivery, expired reservations, invalid requests, and token failures', async () => {
    delete process.env.ORDER_DELIVERY_ENCRYPTION_KEY;
    const encryption = await request(app).post('/orders').set(auth(patientId)).send(orderBody);
    expect(encryption.status).toBe(400);
    expect(tx.reservation.updateMany).not.toHaveBeenCalled();

    process.env.ORDER_DELIVERY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    tx.reservation.findFirst.mockResolvedValueOnce(null);
    expect((await request(app).post('/orders').set(auth(patientId)).send(orderBody)).status).toBe(404);
    expect((await request(app).post('/orders').set(auth(patientId)).send({ ...orderBody, idempotencyKey: 'short' })).status).toBe(400);
    expect((await request(app).get('/orders')).status).toBe(401);
    expect((await request(app).get('/orders').set('Authorization', 'Bearer malformed')).status).toBe(401);
    expect((await request(app).get('/orders').set(auth(patientId, '-1s'))).status).toBe(401);
  });

  it('rolls back safely when order creation fails and does not leak database details', async () => {
    tx.order.create.mockRejectedValueOnce(new Error('database delivery secret'));
    const response = await request(app).post('/orders').set(auth(patientId)).send(orderBody);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ status: 'error', message: 'Orders module temporarily unavailable' });
    expect(response.text).not.toContain('database delivery secret');
  });
});
