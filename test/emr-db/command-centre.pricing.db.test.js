// Delivery pricing from the Command Centre through checkout and order creation, against real Postgres.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { create as createOrder } from '../../src/modules/orders/orders.service.js';
import { tokenFor, prisma } from './fixtures.js';
import { ensureDeliveryKey, hold, marketplacePharmacy, north, person } from './commerce-fixtures.js';

const NAIRA = 100;
const as = (user) => ({
  get: (path) => request(app).get(path).set('Authorization', tokenFor(user.id)),
  post: (path, body = {}) => request(app).post(path).set('Authorization', tokenFor(user.id)).send(body),
  put: (path, body = {}) => request(app).put(path).set('Authorization', tokenFor(user.id)).send(body),
});
const PRICING = '/api/v1/command-centre/pricing/delivery';
const point = ({ latitude, longitude }) => ({ latitude, longitude });
/** A clean rule set: only the per-km rate, nothing else. */
const plain = (ratePerKmNaira) => ({
  deliveryRatePerKmMinor: ratePerKmNaira * NAIRA, platformFeeMinor: 0, baseFeeMinor: 0, includedDistanceKm: 0, minimumFeeMinor: 0, maximumFeeMinor: null,
  maxDistanceKm: null, distanceMethod: 'STRAIGHT_LINE', roadFallbackToStraightLine: false, distanceRounding: 'EXACT', feeRoundingMinor: 1, bands: [], zones: [],
  restrictToZones: false, freeDeliveryThresholdMinor: null, smallOrderThresholdMinor: null, smallOrderFeeMinor: 0, surcharges: [],
});

let admin; let support; let finance; let patient; let shop;
const delivery = (to) => ({ recipientName: 'Synthetic Patient', recipientPhone: '+2348000000001', address: '5 Synthetic Close, Lagos', coordinates: to });
const preview = (cart, to) => as(patient).post(`/api/v1/checkout-pricing/preview/reservations/${cart.id}`, { fulfilments: [{ pharmacyId: shop.pharmacy.id, fulfilmentMethod: 'DELIVERY' }], deliveryCoordinates: to });

beforeAll(async () => {
  ensureDeliveryKey();
  admin = await person('Pricing Admin', { platformRoles: ['SABI_PLATFORM_ADMIN'] });
  support = await person('Support Agent', { platformRoles: ['SABI_SUPPORT'] });
  finance = await person('Finance Officer', { platformRoles: ['SABI_FINANCE'] });
  patient = await person('Checkout Patient', { role: 'PATIENT' });
  shop = await marketplacePharmacy({ unitPriceMinor: 2_500 * NAIRA });
});
afterAll(async () => {
  await as(admin).post(PRICING, { ...plain(600), reason: 'Restore the platform default after tests' });
});

describe('delivery pricing set in the Command Centre', () => {
  it('charges 5 km at ₦200/km as ₦1,000 at checkout, and the order keeps that price after a rate change', async () => {
    const created = await as(admin).post(PRICING, { ...plain(200), reason: 'Set ₦200 per km for the Lagos launch' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const version = created.body.data.version;

    const to = north(shop.branch, 5);
    const cart = await hold(patient, shop.listing);
    const quote = await preview(cart, to);
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    expect(quote.body.data).toMatchObject({ deliveryFeeMinor: 1_000 * NAIRA, subtotalMinor: 2_500 * NAIRA, totalPayableMinor: 3_500 * NAIRA, quote: { pricingVersion: version } });
    const pharmacyQuote = quote.body.data.pharmacies[0];
    expect(pharmacyQuote).toMatchObject({ distanceKm: 5, distanceMethod: 'STRAIGHT_LINE', deliveryFeeMinor: 100_000 });
    expect(pharmacyQuote.deliveryBreakdown).toEqual([expect.objectContaining({ code: 'DISTANCE', label: 'Distance 5 km × ₦200/km', amountMinor: 100_000 })]);
    expect(new Date(quote.body.data.quote.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const { order } = await createOrder(patient.id, { reservationId: cart.id, idempotencyKey: randomUUID(), fulfilments: [{ pharmacyId: shop.pharmacy.id, fulfilmentMethod: 'DELIVERY' }], delivery: delivery(to), expectedTotalPayableMinor: 3_500 * NAIRA });
    expect(order).toMatchObject({ deliveryFeeMinor: 100_000, totalPayableMinor: 350_000, pricingConfigVersion: version });
    expect(order.fulfilments[0]).toMatchObject({ deliveryFeeMinor: 100_000, distanceKm: 5, distanceMethod: 'STRAIGHT_LINE' });

    // A new rate applies to new quotes only.
    expect((await as(admin).post(PRICING, { deliveryRatePerKmMinor: 300 * NAIRA, reason: 'Fuel price increase' })).status).toBe(201);
    const stored = await prisma.orderFulfilment.findFirst({ where: { orderId: order.id } });
    expect(stored.deliveryFeeMinor).toBe(100_000);
    expect(stored.deliveryQuote).toMatchObject({ feeMinor: 100_000, ratePerKmMinor: 20_000, pricingVersion: version });
    const again = await preview(await hold(patient, shop.listing), to);
    expect(again.body.data.deliveryFeeMinor).toBe(1_500 * NAIRA);
  });

  it('refuses to place an order at a price the patient was not shown', async () => {
    await as(admin).post(PRICING, { ...plain(200), reason: 'Back to ₦200 per km' });
    const to = north(shop.branch, 3);
    const cart = await hold(patient, shop.listing);
    const shown = (await preview(cart, to)).body.data;
    expect(shown.deliveryFeeMinor).toBe(600 * NAIRA);
    await as(admin).post(PRICING, { deliveryRatePerKmMinor: 400 * NAIRA, reason: 'Peak pricing trial' });
    await expect(createOrder(patient.id, { reservationId: cart.id, idempotencyKey: randomUUID(), fulfilments: [{ pharmacyId: shop.pharmacy.id, fulfilmentMethod: 'DELIVERY' }], delivery: delivery(to), expectedTotalPayableMinor: shown.totalPayableMinor }))
      .rejects.toMatchObject({ code: 'PRICE_CHANGED', details: { totalPayableMinor: 2_500 * NAIRA + 1_200 * NAIRA, deliveryFeeMinor: 120_000 } });
    // The cart is still held, so the patient can confirm the new price.
    const placed = await createOrder(patient.id, { reservationId: cart.id, idempotencyKey: randomUUID(), fulfilments: [{ pharmacyId: shop.pharmacy.id, fulfilmentMethod: 'DELIVERY' }], delivery: delivery(to), expectedTotalPayableMinor: 3_700 * NAIRA });
    expect(placed.order.deliveryFeeMinor).toBe(120_000);
  });

  it('explains when an address is out of range or invalid', async () => {
    await as(admin).post(PRICING, { ...plain(200), maxDistanceKm: 8, reason: 'Limit deliveries to 8 km' });
    const cart = await hold(patient, shop.listing);
    const far = await preview(cart, north(shop.branch, 9));
    expect(far.status).toBe(422);
    expect(far.body).toMatchObject({ code: 'NOT_SERVICEABLE', details: { reason: 'MAX_DISTANCE', limitKm: 8 } });
    expect(far.body.message).toMatch(/up to 8 km; the address is 9\.0 km away/);
    const beyondTier = await (async () => { await as(admin).post(PRICING, { maxDistanceKm: null, reason: 'Remove the global limit' }); return preview(cart, north(shop.branch, 10.5)); })();
    expect(beyondTier.body).toMatchObject({ code: 'NOT_SERVICEABLE', details: { reason: 'TIER_RADIUS', limitKm: 10 } });
    expect((await preview(cart, { latitude: 120, longitude: 3 })).status).toBe(400);
  });
});

describe('managing pricing versions', () => {
  it('schedules, lists and cancels a future version without changing the price in force', async () => {
    const before = (await as(admin).get(PRICING)).body.data.active;
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = await as(admin).post(PRICING, { deliveryRatePerKmMinor: 999 * NAIRA, effectiveAt: later, reason: 'Planned rate for next month' });
    expect(scheduled.status).toBe(201);
    const listing = (await as(admin).get(PRICING)).body.data;
    expect(listing.active.version).toBe(before.version);
    expect(listing.versions.find((v) => v.version === scheduled.body.data.version)).toMatchObject({ state: 'SCHEDULED', changeReason: 'Planned rate for next month', createdByName: 'Pricing Admin' });
    expect(listing.versions.find((v) => v.version === before.version).state).toBe('ACTIVE');

    expect((await as(admin).post(`${PRICING}/${scheduled.body.data.version}/cancel`, { reason: 'Plan dropped' })).status).toBe(200);
    expect((await as(admin).post(`${PRICING}/${scheduled.body.data.version}/cancel`, { reason: 'Again' })).status).toBe(409);
    expect((await as(admin).post(`${PRICING}/${before.version}/cancel`, { reason: 'Not allowed' })).body.error.code).toBe('INVALID_STATE');
    expect((await as(admin).get(PRICING)).body.data.versions.find((v) => v.version === scheduled.body.data.version)).toMatchObject({ state: 'CANCELLED', cancelledByName: 'Pricing Admin' });
  });

  it('rejects inconsistent rules and road distance with no routing service', async () => {
    expect((await as(admin).post(PRICING, { deliveryRatePerKmMinor: 100 })).status).toBe(400); // no reason
    const overlap = await as(admin).post(PRICING, { bands: [{ fromKm: 0, toKm: 5, ratePerKmMinor: 1 }, { fromKm: 4, toKm: null, ratePerKmMinor: 2 }], reason: 'Overlapping bands' });
    expect(overlap.body).toMatchObject({ error: { code: 'INVALID_PRICING' } });
    expect((await as(admin).post(PRICING, { minimumFeeMinor: 5_000, maximumFeeMinor: 1_000, reason: 'Cap below minimum' })).body.error.code).toBe('INVALID_PRICING');
    expect((await as(admin).post(PRICING, { distanceMethod: 'ROAD', reason: 'Use road distance' })).body.error.code).toBe('ROUTING_NOT_CONFIGURED');
    expect((await as(admin).post(PRICING, { effectiveAt: '2020-01-01T00:00:00Z', reason: 'Backdated change' })).body.error.code).toBe('INVALID_PRICING');
  });

  it('simulates a draft with the checkout calculation, saving nothing', async () => {
    await as(admin).post(PRICING, { ...plain(200), reason: 'Baseline for simulation' });
    const count = await prisma.checkoutPricingConfiguration.count();
    const simulated = await as(support).post(`${PRICING}/simulate`, {
      rules: { baseFeeMinor: 500 * NAIRA, minimumFeeMinor: 2_000 * NAIRA, freeDeliveryThresholdMinor: 50_000 * NAIRA },
      origin: point(shop.branch), destination: north(shop.branch, 5), subtotalMinor: 3_000 * NAIRA, tierRadiusKm: 10,
    });
    expect(simulated.status, JSON.stringify(simulated.body)).toBe(200);
    expect(simulated.body.data.quote).toMatchObject({ feeMinor: 2_000 * NAIRA, distanceKm: 5 });
    expect(simulated.body.data.quote.lines.map((l) => l.code)).toEqual(['BASE_FEE', 'DISTANCE', 'MINIMUM_ADJUSTMENT']);
    expect(await prisma.checkoutPricingConfiguration.count()).toBe(count);
    const live = await as(finance).post(`${PRICING}/simulate`, { origin: point(shop.branch), destination: north(shop.branch, 5), subtotalMinor: 1 });
    expect(live.body.data).toMatchObject({ draft: false, quote: { feeMinor: 1_000 * NAIRA } });
  });
});

describe('who may see and change pricing', () => {
  it('lets operations, support and finance read, only pricing managers change, and patients nothing', async () => {
    expect((await as(support).get(PRICING)).status).toBe(200);
    expect((await as(finance).get(PRICING)).status).toBe(200);
    expect((await as(support).post(PRICING, { deliveryRatePerKmMinor: 1, reason: 'Not my job' })).status).toBe(403);
    expect((await as(finance).post(PRICING, { deliveryRatePerKmMinor: 1, reason: 'Not my job either' })).status).toBe(403);
    expect((await as(patient).get(PRICING)).status).toBe(403);
    expect((await request(app).get(PRICING)).status).toBe(401);
  });

  it('keeps the legacy endpoint working for pricing managers, carrying the other rules forward', async () => {
    await as(admin).post(PRICING, { ...plain(200), baseFeeMinor: 300 * NAIRA, reason: 'Base fee trial' });
    const legacy = await as(admin).put('/api/v1/checkout-pricing/admin', { platformFeeMinor: 0, deliveryRatePerKmMinor: 250 * NAIRA, currency: 'NGN' });
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(200);
    expect(legacy.body.data).toMatchObject({ deliveryRatePerKmMinor: 25_000, baseFeeMinor: 30_000 });
    expect((await as(support).put('/api/v1/checkout-pricing/admin', { platformFeeMinor: 0, deliveryRatePerKmMinor: 1, currency: 'NGN' })).status).toBe(403);
  });

  it('records every change with who, why, before and after — and the audit trail cannot be edited', async () => {
    const change = await as(admin).post(PRICING, { deliveryRatePerKmMinor: 210 * NAIRA, reason: 'Audited rate change' });
    const entry = await prisma.auditEvent.findFirst({ where: { resourceType: 'delivery_pricing', resourceId: String(change.body.data.version) } });
    expect(entry).toMatchObject({ actorUserId: admin.id, category: 'ADMIN', action: 'ADMIN_ACTION' });
    expect(entry.context).toMatchObject({ reason: 'Audited rate change', roles: ['SABI_PLATFORM_ADMIN'], after: { deliveryRatePerKmMinor: 21_000 } });
    expect(entry.context.before.deliveryRatePerKmMinor).not.toBe(21_000);
    await expect(prisma.auditEvent.update({ where: { id: entry.id }, data: { summary: 'Edited' } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditEvent.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
  });
});
