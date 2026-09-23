import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.fn();
const active = vi.fn();
const detail = vi.fn();
const release = vi.fn();

vi.mock('../src/modules/reservations/reservation.service.js', () => ({
  create,
  active,
  detail,
  release,
}));

const { default: routes } = await import('../src/modules/reservations/reservation.routes.js');

process.env.JWT_SECRET = 'reservation-route-test-secret';

const patientId = '11111111-1111-4111-8111-111111111111';
const otherPatientId = '22222222-2222-4222-8222-222222222222';
const prescriptionId = '33333333-3333-4333-8333-333333333333';
const prescriptionItemId = '44444444-4444-4444-8444-444444444444';
const quoteItemId = '55555555-5555-4555-8555-555555555555';
const reservationId = '66666666-6666-4666-8666-666666666666';

const auth = (id = patientId, expiresIn) => ({
  Authorization: `Bearer ${jwt.sign(
    { userId: id },
    process.env.JWT_SECRET,
    expiresIn ? { expiresIn } : undefined,
  )}`,
});

const body = {
  prescriptionId,
  idempotencyKey: 'reservation-retry-key-001',
  allocations: [{ prescriptionItemId, quoteItemId, selectedQuantity: 2 }],
};

const reservation = {
  id: reservationId,
  status: 'ACTIVE',
  expiresAt: new Date('2026-09-13T12:20:00.000Z'),
  allocations: [{
    prescriptionItemId,
    pharmacy: { id: '77777777-7777-4777-8777-777777777777', name: 'Safe Pharmacy' },
    quoteRevision: 2,
    selectedQuantity: 2,
    unitPriceMinor: 12500,
    lineTotalMinor: 25000,
    expiresAt: new Date('2026-09-13T12:20:00.000Z'),
    inventoryItemId: '88888888-8888-4888-8888-888888888888',
    availableQuantity: 999,
    internalQuoteMetadata: 'private',
  }],
};

const app = express();
app.use(express.json());
app.use('/reservations', routes);

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue(reservation);
  active.mockResolvedValue(reservation);
  detail.mockResolvedValue(reservation);
  release.mockResolvedValue(true);
});

describe('reservation routes', () => {
  it('creates a patient reservation and returns only patient-safe snapshots', async () => {
    const response = await request(app).post('/reservations').set(auth()).send(body);

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(patientId, body);
    expect(response.body.data).toEqual(expect.objectContaining({
      id: reservationId,
      status: 'ACTIVE',
      reservationExpiresAt: reservation.expiresAt.toJSON(),
    }));
    const allocation = response.body.data.allocations[0];
    expect(allocation).toEqual(expect.objectContaining({
      prescriptionItemId,
      selectedQuantity: 2,
      unitPriceMinor: 12500,
      lineTotalMinor: 25000,
    }));
    expect(allocation).not.toHaveProperty('inventoryItemId');
    expect(allocation).not.toHaveProperty('availableQuantity');
    expect(allocation).not.toHaveProperty('internalQuoteMetadata');
  });

  it('handles an idempotent retry without a second client-visible creation', async () => {
    const first = await request(app).post('/reservations').set(auth()).send(body);
    const retry = await request(app).post('/reservations').set(auth()).send(body);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body.data.id).toBe(reservationId);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('returns an active reservation, owner-scoped detail, and releases it', async () => {
    const current = await request(app).get('/reservations/active').set(auth());
    const single = await request(app).get(`/reservations/${reservationId}`).set(auth());
    const removed = await request(app).delete(`/reservations/${reservationId}`).set(auth());

    expect(current.status).toBe(200);
    expect(active).toHaveBeenCalledWith(patientId);
    expect(single.status).toBe(200);
    expect(detail).toHaveBeenCalledWith(patientId, reservationId);
    expect(removed.status).toBe(200);
    expect(release).toHaveBeenCalledWith(patientId, reservationId);
    expect(removed.body.data).toEqual({ id: reservationId, status: 'RELEASED' });
  });

  it('uses the same safe not-found response for missing and cross-user records', async () => {
    detail.mockResolvedValueOnce(null);
    release.mockResolvedValueOnce(false);

    const missing = await request(app)
      .get(`/reservations/${reservationId}`)
      .set(auth(otherPatientId));
    const crossUser = await request(app)
      .delete(`/reservations/${reservationId}`)
      .set(auth(otherPatientId));

    expect(missing.status).toBe(404);
    expect(crossUser.status).toBe(404);
    expect(missing.body).toEqual(crossUser.body);
    expect(detail).toHaveBeenCalledWith(otherPatientId, reservationId);
    expect(release).toHaveBeenCalledWith(otherPatientId, reservationId);
  });

  it('rejects missing, malformed, and expired authentication tokens', async () => {
    const missing = await request(app).get('/reservations/active');
    const malformed = await request(app)
      .get('/reservations/active')
      .set('Authorization', 'Bearer malformed.token');
    const expiredToken = jwt.sign({ userId: patientId }, process.env.JWT_SECRET, { expiresIn: -1 });
    const expired = await request(app)
      .get('/reservations/active')
      .set('Authorization', `Bearer ${expiredToken}`);

    expect(missing.status).toBe(401);
    expect(malformed.status).toBe(401);
    expect(expired.status).toBe(401);
  });

  it('rejects invalid IDs, idempotency keys, and malformed allocations', async () => {
    expect((await request(app).get('/reservations/not-a-uuid').set(auth())).status).toBe(400);
    expect((await request(app).post('/reservations').set(auth()).send({ ...body, idempotencyKey: 'short' })).status).toBe(400);
    expect((await request(app).post('/reservations').set(auth()).send({ ...body, allocations: [{}] })).status).toBe(400);
  });

  it('returns safe validation errors for coverage, quote, and stock failures', async () => {
    for (const code of ['COVERAGE', 'INVALID', 'STOCK']) {
      create.mockRejectedValueOnce(Object.assign(new Error(`private-${code}`), { code }));
      const response = await request(app).post('/reservations').set(auth()).send(body);
      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Reservation cannot be created');
      expect(response.text).not.toContain(`private-${code}`);
    }
  });

  it('returns the module-safe error contract for transaction failures', async () => {
    create.mockRejectedValueOnce(new Error('database connection secret'));
    const response = await request(app).post('/reservations').set(auth()).send(body);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      status: 'error',
      message: 'Reservation module temporarily unavailable',
    });
    expect(response.text).not.toContain('database connection secret');
  });
});
