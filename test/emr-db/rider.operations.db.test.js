import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { prisma, tokenFor } from './fixtures.js';
import { person, marketplacePharmacy, ensureDeliveryKey, hold, north } from './commerce-fixtures.js';
import { create as createOrder } from '../../src/modules/orders/orders.service.js';
import * as delivery from '../../src/modules/delivery/delivery.service.js';
import { openCode } from '../../src/modules/delivery/delivery.codes.js';
import * as ops from '../../src/modules/riders/riders.operations.js';
import * as money from '../../src/modules/riders/riders.payments.js';

let operator, rider, other, patient, shop, checker, previousPolicy;
const req = (user) => ({ user: { id: user.id }, accessContext: { roles: [] }, headers: {} });
beforeAll(async () => {
  ensureDeliveryKey();
  previousPolicy = await prisma.riderPayPolicy.findUnique({ where: { id: 'default' } });
  operator = await person('Rider Ops', { platformRoles: ['SABI_PLATFORM_ADMIN'] });
  checker = await person('Rider Finance', { platformRoles: ['SABI_FINANCE'] });
  rider = await person('Synthetic Rider', { role: 'DELIVERY_PARTNER' });
  other = await person('Other Rider', { role: 'DELIVERY_PARTNER' });
  patient = await person('Rider Customer', { role: 'PATIENT' });
  await prisma.deliveryPartner.create({ data: { userId: rider.id, displayName: rider.full_name, configuredByUserId: operator.id, isActive: true } });
  await prisma.deliveryPartner.create({ data: { userId: other.id, displayName: other.full_name, configuredByUserId: operator.id, isActive: true } });
  shop = await marketplacePharmacy();
  await prisma.riderPayPolicy.update({ where: { id: 'default' }, data: { published: true, riderShareBps: 8000, maxOpenAssignments: 1, automaticDispatch: false, updatedByUserId: operator.id } });
});
afterAll(async () => {
  if (previousPolicy) { const { id, ...data } = previousPolicy; await prisma.riderPayPolicy.update({ where: { id }, data }); }
  if (operator && checker) await prisma.user.updateMany({ where: { id: { in: [operator.id, checker.id] } }, data: { accountStatus: 'DISABLED' } });
});
async function ready() {
  const cart = await hold(patient, shop.listing);
  const { order } = await createOrder(patient.id, { reservationId: cart.id, idempotencyKey: randomUUID(), fulfilments: [{ pharmacyId: shop.pharmacy.id, fulfilmentMethod: 'DELIVERY' }], delivery: { recipientName: 'Synthetic Customer', recipientPhone: '+2347000000000', address: 'Synthetic delivery address', coordinates: north(shop.branch, 5) } });
  await prisma.order.update({ where: { id: order.id }, data: { status: 'PAID' } });
  const f = await prisma.orderFulfilment.findFirst({ where: { orderId: order.id } });
  return prisma.orderFulfilment.update({ where: { id: f.id }, data: { status: 'READY_FOR_PICKUP', inventoryFinalizedAt: new Date(), deliveryQuote: { ...f.deliveryQuote, distanceKm: 5, ratePerKmMinor: 100000 } } });
}
describe('Kilometre-priced rider operations with real PostgreSQL', () => {
  it('enforces online versioning, dispatches to the frozen branch and shows only the earning offer', async () => {
    const state = await ops.availability(rider.id);
    await ops.setAvailability(rider.id, { expectedVersion: state.availabilityVersion, available: true, durationMinutes: 60, location: { latitude: shop.branch.latitude, longitude: shop.branch.longitude, accuracyMeters: 10 } });
    await expect(ops.setAvailability(rider.id, { expectedVersion: state.availabilityVersion, available: false })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const f = await ready();
    const offer = await ops.dispatchOne(f.id, operator.id);
    expect(offer.earningOfferMinor).toBe(400000); // ₦1,000 × 5 km × 80%.
    await expect(ops.dispatchOne(f.id, operator.id)).rejects.toMatchObject({ code: 'ALREADY_ASSIGNED' });
    const view = await delivery.detail(rider.id, offer.id);
    expect(view.pickup.address).toBe(shop.branch.address);
    expect(view).not.toHaveProperty('recipient');
    expect(JSON.stringify(view)).not.toMatch(/payShare|payGross|payRetained|policyVersion|ratePerKm/);
    expect((await request(app).get('/api/v1/delivery/offer-notifications').set('Authorization', tokenFor(rider.id))).body.data.items[0].message).toContain('4,000');
    await expect(delivery.detail(other.id, offer.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(prisma.deliveryAssignment.update({ where: { id: offer.id }, data: { earningOfferMinor: 123 } })).rejects.toThrow();
    await prisma.riderPayPolicy.update({ where: { id: 'default' }, data: { riderShareBps: 7000, version: { increment: 1 } } });
    expect((await delivery.detail(rider.id, offer.id)).earningOfferMinor).toBe(400000);
    await delivery.respond(rider.id, offer.id);
    const issue = await ops.reportException(rider.id, offer.id, { kind: 'ADDRESS_ISSUE', note: 'Synthetic customer requested clarification.' });
    const duplicate = await ops.reportException(rider.id, offer.id, { kind: 'OTHER', note: 'Duplicate report must reuse the open issue.' });
    expect(duplicate.id).toBe(issue.id);
    await ops.resolveException(req(operator), issue.id, { expectedVersion: issue.version, resolution: 'CONTACTED_RECIPIENT', reason: 'Synthetic address confirmed with the recipient.' });
    expect((await prisma.orderFulfilment.findUnique({ where: { id: f.id } })).status).toBe('READY_FOR_PICKUP');
    const stored = await prisma.deliveryAssignment.findUnique({ where: { id: offer.id } });
    await expect(delivery.transition(rider.id, offer.id, { status: 'PICKED_UP', code: 'invalid' })).rejects.toMatchObject({ code: 'CODE_INVALID' });
    await delivery.transition(rider.id, offer.id, { status: 'PICKED_UP', code: openCode(offer.id, 'pickup', stored.pickupCodeEncrypted) });
    await delivery.transition(rider.id, offer.id, { status: 'OUT_FOR_DELIVERY' });
    await delivery.transition(rider.id, offer.id, { status: 'DELIVERED', code: openCode(offer.id, 'delivery', stored.deliveryCodeEncrypted) });
    await expect(delivery.transition(rider.id, offer.id, { status: 'DELIVERED', code: '123456' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const ledger = await money.riderEarnings(rider.id);
    expect(ledger.availableMinor).toBe(400000);
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]).not.toHaveProperty('policyVersion');
    await expect(prisma.riderEarning.update({ where: { id: ledger.items[0].id }, data: { amountMinor: 500000 } })).rejects.toThrow();
  });
  it('verifies bank ownership and freezes the withdrawal snapshot, never allocating an earning twice', async () => {
    const gateway = { bankList: async () => [{ code: '058', name: 'Synthetic Bank' }], resolveBank: async () => ({ account_name: 'Synthetic Rider', account_number: '0123456789' }), createRecipient: async () => ({ recipient_code: 'RCP_synthetic' }) };
    await expect(money.saveRiderBank(other.id, { accountNumber: '0123456789', bankCode: '058', expectedRevision: 0 }, { gateway })).rejects.toMatchObject({ code: 'BANK_NAME_MISMATCH' });
    const bank = await money.saveRiderBank(rider.id, { accountNumber: '0123456789', bankCode: '058', expectedRevision: 0 }, { gateway });
    expect(bank).not.toHaveProperty('recipientCode'); expect(bank).not.toHaveProperty('accountNumber');
    const data = { requestKey: randomUUID(), expectedBankRevision: bank.revision };
    const payout = await money.requestRiderPayout(rider.id, data);
    expect((await money.requestRiderPayout(rider.id, data)).id).toBe(payout.id);
    await expect(money.requestRiderPayout(rider.id, { ...data, requestKey: randomUUID() })).rejects.toMatchObject({ code: 'NO_AVAILABLE_EARNINGS' });
    await expect(money.approveRiderPayout(req(rider), payout.id, 'Synthetic self approval')).rejects.toMatchObject({ code: 'MAKER_CHECKER_REQUIRED' });
    await money.approveRiderPayout(req(checker), payout.id, 'Synthetic independently checked earning and bank.');
    await expect(prisma.riderPayout.update({ where: { id: payout.id }, data: { amountMinor: 1 } })).rejects.toThrow();
    const gatewayTransfer = { operationsConfigured: () => true, sendTransfer: async ({ reference }) => ({ reference, transfer_code: 'TRF_synthetic', status: 'pending' }) };
    const sent = await money.submitRiderPayout(req(operator), payout.id, 'Synthetic transfer only, no provider network.', { gateway: gatewayTransfer });
    expect(sent.status).toBe('SUBMITTED');
    const attempt = await prisma.riderTransferAttempt.findFirst({ where: { payoutId: payout.id } });
    await expect(money.approveRiderPayout(req(checker), payout.id, 'No retry before verification')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const result = { reference: attempt.reference, amount: payout.amountMinor, currency: 'NGN', recipient: { recipient_code: 'RCP_synthetic' }, status: 'success', transfer_code: 'TRF_synthetic' };
    await expect(money.reconcileRiderTransfer(attempt.reference, { gateway: { verifyTransfer: async () => ({ ...result, amount: 1 }) } })).rejects.toMatchObject({ code: 'PROVIDER_MISMATCH' });
    expect((await prisma.riderPayout.findUnique({ where: { id: payout.id } })).status).toBe('SUBMITTED');
    const confirmed = await money.reconcileRiderTransfer(attempt.reference, { gateway: { verifyTransfer: async () => result } });
    expect(confirmed.status).toBe('PAID');
    const replay = await money.reconcileRiderTransfer(attempt.reference, { gateway: { verifyTransfer: async () => result } });
    expect(replay.paidAt).toEqual(confirmed.paidAt);
    await money.queueRiderTransferVerification({ event: 'transfer.reversed', data: { reference: attempt.reference } });
    expect((await prisma.riderTransferAttempt.findUnique({ where: { id: attempt.id } })).verificationRequested).toBe(true);
    expect((await money.reconcileRiderTransfer(attempt.reference, { gateway: { verifyTransfer: async () => ({ ...result, status: 'reversed' }) } })).status).toBe('REVERSED');
    expect((await money.riderEarnings(rider.id)).availableMinor).toBe(0);
  });
  it('expires unanswered offers without changing stock or crediting an earning', async () => {
    const f = await ready();
    const a = await delivery.assign(shop.owner.id, f.id, { partnerId: (await prisma.deliveryPartner.findUnique({ where: { userId: other.id } })).id });
    await prisma.deliveryAssignment.update({ where: { id: a.id }, data: { offerExpiresAt: new Date(Date.now() - 1000) } });
    await expect(delivery.respond(other.id, a.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await ops.expireRiderOffers();
    expect((await prisma.deliveryAssignment.findUnique({ where: { id: a.id } })).status).toBe('REJECTED');
    expect((await prisma.orderFulfilment.findUnique({ where: { id: f.id } })).status).toBe('READY_FOR_PICKUP');
    expect(await prisma.riderEarning.count({ where: { assignmentId: a.id } })).toBe(0);
  });
});
