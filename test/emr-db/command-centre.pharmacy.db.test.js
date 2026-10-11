// Command Centre pharmacy exceptions against real Postgres: published products out of stock or low,
// batches expired or expiring, withdrawn and rejected listings, grouped by pharmacy and branch.
// All data is synthetic.
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { tokenFor, prisma } from './fixtures.js';
import { marketplacePharmacy, person } from './commerce-fixtures.js';

const CC = '/api/v1/command-centre';
const get = (user, path) => request(app).get(`${CC}${path}`).set('Authorization', tokenFor(user.id));
const day = (n) => new Date(Date.now() + n * 86_400_000);

let support; let outsider; let shop; let annex; const ids = {};

async function item(name, { branchId = shop.branch.id, listing, ...data }) {
  const row = await prisma.pharmacyInventoryItem.create({
    data: { pharmacyId: shop.pharmacy.id, branchId, medicationName: `${name} ${randomUUID().slice(0, 6)}`, unitPriceMinor: 10_000, isActive: true, ...data },
  });
  if (listing) {
    await prisma.pharmacyListing.create({
      data: { inventoryItemId: row.id, category: 'DEVICES', description: 'Synthetic test product', productClass: 'NON_MEDICINAL', imageBytes: Buffer.from('synthetic'), imageHash: 'c'.repeat(64), reviewedBy: shop.listing.reviewedBy, reviewedAt: new Date(), ...listing },
    });
  }
  return row.id;
}

beforeAll(async () => {
  support = await person('Pharmacy Ops', { platformRoles: ['SABI_SUPPORT'] });
  outsider = await person('Not Staff', { role: 'PATIENT' });
  shop = await marketplacePharmacy({ quantity: 50 }); // healthy published product: never an exception
  annex = await prisma.pharmacyBranch.create({
    data: { pharmacyId: shop.pharmacy.id, name: 'Annex branch', address: '2 Synthetic Road', latitude: 6.53, longitude: 3.38, premisesLicenceNumber: 'PCN-ANNEX', licenceExpiresAt: day(365), status: 'VERIFIED' },
  });
  ids.out = await item('Out of stock', { availableQuantity: 0, listing: { status: 'PUBLISHED' } });
  ids.low = await item('Low stock', { availableQuantity: 3, reorderPoint: 5, listing: { status: 'PUBLISHED' } });
  ids.lowByThreshold = await item('Below threshold', { availableQuantity: 8, listing: { status: 'PUBLISHED' } });
  ids.expired = await item('Expired batch', { availableQuantity: 10, batchNumber: 'B-EXP', expiryDate: day(-3) });
  ids.soon = await item('Expiring soon', { branchId: annex.id, availableQuantity: 4, batchNumber: 'B-20', expiryDate: day(20) });
  ids.later = await item('Expiring later', { branchId: annex.id, availableQuantity: 4, batchNumber: 'B-75', expiryDate: day(75) });
  ids.withdrawn = await item('Withdrawn', { availableQuantity: 9, listing: { status: 'WITHDRAWN' } });
  ids.rejected = await item('Rejected', { availableQuantity: 9, listing: { status: 'REJECTED', reviewNote: 'Synthetic: image does not match product', reviewedAt: new Date() } });
  ids.emptyExpired = await item('Empty expired', { availableQuantity: 0, expiryDate: day(-10) });
  ids.inactive = await item('Inactive', { availableQuantity: 0, isActive: false, listing: { status: 'PUBLISHED' } });
  ids.draftEmpty = await item('Draft empty', { availableQuantity: 0, listing: { status: 'DRAFT' } });
});
// Other suites count active platform administrators; leave none of ours active.
afterAll(async () => {
  await prisma.user.updateMany({ where: { platformRoleAssignments: { some: {} }, email: { endsWith: '@command.test' } }, data: { accountStatus: 'DISABLED' } });
});

const forShop = (extra = '') => `/pharmacy-exceptions?pharmacyId=${shop.pharmacy.id}&limit=100${extra}`;
const byId = (body) => Object.fromEntries(body.data.items.map((i) => [i.id, i]));

describe('pharmacy exceptions', () => {
  it('is for platform staff only and never cached', async () => {
    expect((await request(app).get(`${CC}/pharmacy-exceptions`)).status).toBe(401);
    expect((await get(outsider, '/pharmacy-exceptions')).status).toBe(403);
    const res = await get(support, '/pharmacy-exceptions');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.definitions.LOW_STOCK).toMatch(/reorder point/);
  });

  it('flags stock, expiry and listing problems and nothing healthy', async () => {
    const res = await get(support, forShop());
    expect(res.status).toBe(200);
    const items = byId(res.body);
    expect(items[ids.out].types).toEqual(['OUT_OF_STOCK']);
    expect(items[ids.low].types).toEqual(['LOW_STOCK']);
    expect(items[ids.expired]).toMatchObject({ types: ['EXPIRED'], expiryBand: 'EXPIRED', batchNumber: 'B-EXP' });
    expect(items[ids.expired].daysToExpiry).toBeLessThan(0);
    expect(items[ids.soon]).toMatchObject({ types: ['EXPIRING'], expiryBand: '30', branch: { id: annex.id, name: 'Annex branch' } });
    expect(items[ids.later]).toMatchObject({ types: ['EXPIRING'], expiryBand: '90' });
    expect(items[ids.withdrawn].types).toEqual(['WITHDRAWN']);
    expect(items[ids.rejected]).toMatchObject({ types: ['REJECTED'], listing: { status: 'REJECTED', reviewNote: 'Synthetic: image does not match product' } });
    for (const quiet of [shop.item.id, ids.lowByThreshold, ids.emptyExpired, ids.inactive, ids.draftEmpty]) expect(items[quiet]).toBeUndefined();
    expect(res.body.data.total).toBe(7);
    expect(JSON.stringify(res.body)).not.toMatch(/imageBytes|image_bytes/);

    // Grouped by pharmacy and branch, branches in name order.
    const groups = res.body.data.groups;
    expect(groups.map((g) => g.branch?.name)).toEqual(['Annex branch', 'Main branch']);
    expect(groups[0].counts).toMatchObject({ items: 2, expiring: 2 });
    expect(groups[1].counts).toMatchObject({ items: 5, outOfStock: 1, lowStock: 1, expired: 1, withdrawn: 1, rejected: 1 });
    expect(groups.every((g) => g.pharmacy.id === shop.pharmacy.id)).toBe(true);

    // Platform-wide tiles include this pharmacy's exceptions.
    const s = res.body.data.summary;
    expect(s.outOfStock).toBeGreaterThanOrEqual(1);
    expect(s.expiring30).toBeGreaterThanOrEqual(1);
    expect(s.expiring90).toBeGreaterThanOrEqual(s.expiring60);
    expect(s.expiring60).toBeGreaterThanOrEqual(s.expiring30);
  });

  it('filters by window, type, threshold, branch and search', async () => {
    const in30 = byId((await get(support, forShop('&within=30'))).body);
    expect(in30[ids.soon]).toBeDefined();
    expect(in30[ids.later]).toBeUndefined();

    const low = await get(support, forShop('&type=LOW_STOCK&lowStockAt=10'));
    expect(low.body.data.items.map((i) => i.id).sort()).toEqual([ids.low, ids.lowByThreshold].sort());

    const annexOnly = await get(support, forShop(`&branchId=${annex.id}`));
    expect(annexOnly.body.data.items.map((i) => i.id).sort()).toEqual([ids.soon, ids.later].sort());

    const search = await get(support, forShop('&search=B-EXP'));
    expect(search.body.data.items.map((i) => i.id)).toEqual([ids.expired]);

    const page = await get(support, `/pharmacy-exceptions?pharmacyId=${shop.pharmacy.id}&limit=2&page=2`);
    expect(page.body.data).toMatchObject({ total: 7, page: 2, pages: 4 });
    expect(page.body.data.items).toHaveLength(2);

    expect((await get(support, '/pharmacy-exceptions?within=45')).status).toBe(400);
    expect((await get(support, '/pharmacy-exceptions?type=SOMETHING')).status).toBe(400);
  });
});
