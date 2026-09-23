import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const initialize = vi.fn();
const status = vi.fn();
const webhook = vi.fn();
const validSignature = vi.fn();
vi.mock('../src/modules/payments/payments.service.js', () => ({ initialize, status, webhook }));
vi.mock('../src/modules/payments/paystack.adapter.js', () => ({ validSignature }));
const { c, paymentRoutes, paystackWebhook } = await import('../src/modules/payments/payments.routes.js');
process.env.JWT_SECRET = 'payment-test';
const patientId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const auth = (expiresIn) => ({ Authorization: `Bearer ${jwt.sign({ userId: patientId }, process.env.JWT_SECRET, expiresIn ? { expiresIn } : undefined)}` });
const app = express(); app.post('/payments/paystack/webhook', paystackWebhook, c.webhook); app.use(express.json()); app.use('/', paymentRoutes);
beforeEach(() => { vi.clearAllMocks(); initialize.mockResolvedValue({ idempotent: false, payment: { reference: 'SHP-1', status: 'PENDING', amountMinor: 12000, currency: 'NGN', authorizationUrl: 'https://checkout.paystack.test' } }); status.mockResolvedValue({ reference: 'SHP-1', status: 'PENDING', amountMinor: 12000, currency: 'NGN' }); validSignature.mockReturnValue(true); webhook.mockResolvedValue({ paid: true }); });
describe('payment HTTP routes', () => {
  it('initializes only an authenticated request with a strict idempotency key and returns safe provider data', async () => { const response = await request(app).post(`/orders/${orderId}/payment/initialize`).set(auth()).send({ idempotencyKey: 'payment-idempotency-key-001' }); expect(response.status).toBe(201); expect(initialize).toHaveBeenCalledWith(patientId, orderId, 'payment-idempotency-key-001'); expect(response.body.data).not.toHaveProperty('amount'); expect((await request(app).post(`/orders/${orderId}/payment/initialize`).set(auth()).send({ idempotencyKey: 'short' })).status).toBe(400); expect((await request(app).post(`/orders/${orderId}/payment/initialize`).send({ idempotencyKey: 'payment-idempotency-key-001' })).status).toBe(401); });
  it('returns idempotent payment initialization and patient payment status', async () => { initialize.mockResolvedValueOnce({ idempotent: true, payment: { reference: 'SHP-1', status: 'PENDING', amountMinor: 12000, currency: 'NGN' } }); expect((await request(app).post(`/orders/${orderId}/payment/initialize`).set(auth()).send({ idempotencyKey: 'payment-idempotency-key-001' })).status).toBe(200); const response = await request(app).get(`/orders/${orderId}/payment`).set(auth()); expect(response.status).toBe(200); expect(status).toHaveBeenCalledWith(patientId, orderId); });
  it('rejects malformed and expired tokens and safe provider configuration failures', async () => { expect((await request(app).get(`/orders/${orderId}/payment`).set('Authorization', 'Bearer bad')).status).toBe(401); expect((await request(app).get(`/orders/${orderId}/payment`).set(auth('-1s'))).status).toBe(401); initialize.mockRejectedValueOnce(Object.assign(new Error('config'), { code: 'CONFIG' })); const response = await request(app).post(`/orders/${orderId}/payment/initialize`).set(auth()).send({ idempotencyKey: 'payment-idempotency-key-001' }); expect(response.status).toBe(503); expect(response.body.code).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED'); });
  it('verifies raw webhook signatures and acknowledges duplicate-safe processing', async () => { const body = JSON.stringify({ event: 'charge.success', data: { reference: 'SHP-1', amount: 12000, currency: 'NGN', status: 'success' } }); const accepted = await request(app).post('/payments/paystack/webhook').set('x-paystack-signature', 'signature').set('Content-Type', 'application/json').send(body); expect(accepted.status).toBe(200); expect(webhook).toHaveBeenCalled(); validSignature.mockReturnValueOnce(false); expect((await request(app).post('/payments/paystack/webhook').set('Content-Type', 'application/json').send(body)).status).toBe(401); });
});
