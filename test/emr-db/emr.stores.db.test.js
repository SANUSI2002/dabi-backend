// Hospital stores against real Postgres with RLS on: receiving, FEFO issue that skips expired and
// quarantined stock, adjustment, write-off, quarantine/recall/release, transfers keeping batch
// identity, requisitions (partial then full fulfilment), stock counts, permissions and isolation.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { prisma } from './fixtures.js';
import { addMember, createTenant } from './fixtures.js';

const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    patch: (path, body = {}, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let officer; let nurse; let admin; let desk; let bOfficer; let loc; let item;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const state = async (who = officer) => (await as(who).get('/stores')).body.data;
const onHand = (s, itemId, locationId) => s.batches.filter((b) => b.itemId === itemId && (!locationId || b.locationId === locationId)).reduce((n, b) => n + b.qtyRemaining, 0);

beforeAll(async () => {
  A = await createTenant('stA');
  B = await createTenant('stB');
  officer = await member(A, ['INVENTORY_OFFICER']);
  nurse = await member(A, ['NURSE']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  desk = await member(A, ['RECEPTIONIST']);
  bOfficer = await member(B, ['INVENTORY_OFFICER']);
  const first = await state();
  loc = Object.fromEntries(first.locations.map((l) => [l.code, l.id]));
  item = (await as(officer).post('/stores/items', { sku: 'glv-m', name: 'Examination gloves (M)', category: 'PPE', unit: 'box', reorderLevel: 20, minLevel: 5 })).body.data;
});

describe('hospital stores', () => {
  it('starts each hospital with the usual storage locations and rejects duplicate SKUs', async () => {
    expect(Object.keys(loc)).toEqual(expect.arrayContaining(['MAIN', 'PHARM', 'MEDW', 'MAT']));
    expect(item).toMatchObject({ sku: 'GLV-M', category: 'PPE' });
    expect((await as(officer).post('/stores/items', { sku: 'GLV-M', name: 'Again', category: 'PPE', unit: 'box' })).body.error.code).toBe('STORE_SKU_IN_USE');
    expect((await as(officer).post('/stores/locations', { code: 'MAIN', name: 'Dup', type: 'STORE' })).body.error.code).toBe('STORE_LOCATION_CODE_IN_USE');
  });

  it('receives batches and issues earliest-expiry first, never expired or quarantined stock', async () => {
    const receive = (qty, extra) => as(officer).post('/stores/receipts', { itemId: item.id, locationId: loc.MAIN, qty, unitCostMinor: 250000, ...extra }, key());
    expect((await receive(10, { batchNumber: 'OLD', expiryDate: inDays(-1) })).status).toBe(400); // expired on arrival
    const late = await receive(30, { batchNumber: 'LATE', expiryDate: inDays(200) });
    expect(late.status, JSON.stringify(late.body)).toBe(201);
    const soon = await receive(20, { batchNumber: 'SOON', expiryDate: inDays(20) });
    // An already-received batch that has since expired (backdated directly) must be skipped.
    await prisma.emrStoreBatch.create({ data: { organizationId: A.organizationId, itemId: item.id, locationId: loc.MAIN, batchNumber: 'EXP', expiryDate: new Date(Date.now() - 2 * 86_400_000), qtyReceived: 5, qtyRemaining: 5, unitCostMinor: 100000n, source: 'RECEIPT' } });

    const issued = await as(officer).post('/stores/issues', { itemId: item.id, locationId: loc.MAIN, qty: 25, department: 'Emergency', purpose: 'Patient care' }, key());
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    let s = await state();
    const batch = (n) => s.batches.find((b) => b.itemId === item.id && b.batchNumber === n);
    expect(batch('SOON')).toBeUndefined(); // fully used (20) first
    expect(batch('LATE').qtyRemaining).toBe(25);
    expect(batch('EXP').qtyRemaining).toBe(5);
    expect((await as(officer).post('/stores/issues', { itemId: item.id, locationId: loc.MAIN, qty: 26 }, key())).body.error).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { available: 25 } });

    // Quarantine holds stock out of issue; release puts it back; a recall quarantines the whole lot.
    expect((await as(officer).post(`/stores/batches/${batch('LATE').id}/quarantine`, { reason: 'Torn packaging' })).body.data.status).toBe('QUARANTINED');
    expect((await as(officer).post('/stores/issues', { itemId: item.id, locationId: loc.MAIN, qty: 1 }, key())).body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await as(officer).post(`/stores/batches/${batch('LATE').id}/release`)).body.data.status).toBe('ACTIVE');
    expect((await as(officer).post('/stores/recalls', { itemId: item.id, batchNumber: 'LATE', reason: 'Manufacturer notice' })).body.data.quarantined).toBe(1);
    s = await state();
    expect(batch('LATE')).toMatchObject({ status: 'QUARANTINED', quarantineReason: 'Recall: Manufacturer notice', quarantinedByName: expect.any(String) });
    expect((await as(officer).post(`/stores/batches/${batch('LATE').id}/release`)).status).toBe(200);

    // Write-off takes expired stock first; a named batch can be written off directly.
    const off = await as(officer).post('/stores/write-offs', { itemId: item.id, locationId: loc.MAIN, qty: 5, reason: 'Expired' }, key());
    expect(off.body.data).toMatchObject({ qty: 5, valueMinor: 500000 });
    s = await state();
    expect(batch('EXP')).toBeUndefined();
    expect(onHand(s, item.id, loc.MAIN)).toBe(25);
    expect(s.movements.filter((m) => m.itemId === item.id).map((m) => m.kind)).toEqual(expect.arrayContaining(['RECEIPT', 'ISSUE', 'WRITE_OFF']));
    expect(soon.body.data.qty).toBe(20);
  });

  it('adjusts to the counted quantity and moves stock between locations keeping the batch', async () => {
    expect((await as(officer).post('/stores/adjustments', { itemId: item.id, locationId: loc.MAIN, qtyDelta: 3, reason: 'Found in cupboard' }, key())).status).toBe(201);
    expect((await as(officer).post('/stores/adjustments', { itemId: item.id, locationId: loc.MAIN, qtyDelta: -1, reason: 'Damaged box' }, key())).status).toBe(201);
    let s = await state();
    expect(onHand(s, item.id, loc.MAIN)).toBe(27);
    const moved = await as(officer).post('/stores/transfers', { itemId: item.id, qty: 10, fromLocationId: loc.MAIN, toLocationId: loc.ER, reference: 'ER top-up' }, key());
    expect(moved.status, JSON.stringify(moved.body)).toBe(201);
    s = await state();
    expect(onHand(s, item.id, loc.ER)).toBe(10);
    expect(s.batches.find((b) => b.itemId === item.id && b.locationId === loc.ER)).toMatchObject({ batchNumber: 'LATE', unitCostMinor: 250000 });
    expect(s.transfers.find((t) => t.id === moved.body.data.transferId)).toMatchObject({ qty: 10, valueMinor: 2500000, userName: expect.any(String) });
    expect((await as(officer).post('/stores/transfers', { itemId: item.id, qty: 1, fromLocationId: loc.ER, toLocationId: loc.ER }, key())).status).toBe(400);
  });

  it('runs a requisition from a ward through approval and partial, then full, fulfilment', async () => {
    const raised = await as(nurse).post('/stores/requisitions', { requestingLocationId: loc.MEDW, neededBy: inDays(2), justification: 'Weekly restock', submit: true, lines: [{ itemId: item.id, qtyRequested: 20 }] }, key());
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);
    expect(raised.body.data).toMatchObject({ status: 'PENDING_APPROVAL', number: expect.stringMatching(/^REQ-\d{4}-\d{6}$/) });
    const id = raised.body.data.id;
    expect((await as(nurse).post(`/stores/requisitions/${id}/approve`, {}, ifMatch(1))).status).toBe(403);
    expect((await as(admin).post(`/stores/requisitions/${id}/approve`, {}, ifMatch(1))).status).toBe(200);
    const part = await as(admin).post(`/stores/requisitions/${id}/fulfil`, { fulfillingLocationId: loc.MAIN }, ifMatch(2));
    expect(part.body.data, JSON.stringify(part.body)).toMatchObject({ issued: 17, status: 'PARTIALLY_FULFILLED' });
    await as(officer).post('/stores/receipts', { itemId: item.id, locationId: loc.MAIN, qty: 10, unitCostMinor: 260000, batchNumber: 'NEW', expiryDate: inDays(300) }, key());
    const rest = await as(admin).post(`/stores/requisitions/${id}/fulfil`, { fulfillingLocationId: loc.MAIN }, ifMatch(3));
    expect(rest.body.data).toMatchObject({ issued: 3, status: 'FULFILLED' });
    const s = await state();
    expect(s.requisitions.find((r) => r.id === id)).toMatchObject({ status: 'FULFILLED', lines: [{ itemId: item.id, qtyRequested: 20, qtyIssued: 20 }], decidedByName: expect.any(String) });
    expect(onHand(s, item.id, loc.MEDW)).toBe(20);
    expect((await as(admin).post(`/stores/requisitions/${id}/cancel`, {}, ifMatch(4))).status).toBe(409);

    const draft = (await as(nurse).post('/stores/requisitions', { requestingLocationId: loc.MAT, lines: [{ itemId: item.id, qtyRequested: 2 }] }, key())).body.data;
    expect(draft.status).toBe('DRAFT');
    expect((await as(nurse).post(`/stores/requisitions/${draft.id}/submit`, {}, ifMatch(1))).status).toBe(200);
    expect((await as(admin).post(`/stores/requisitions/${draft.id}/reject`, {}, ifMatch(2))).status).toBe(400);
    expect((await as(admin).post(`/stores/requisitions/${draft.id}/reject`, { reason: 'Use the ward stock first' }, ifMatch(2))).status).toBe(200);
  });

  it('counts a location and posts the variance', async () => {
    const before = onHand(await state(), item.id, loc.MAIN);
    const count = (await as(officer).post('/stores/counts', { locationId: loc.MAIN, itemIds: [item.id], note: 'Month end' })).body.data;
    expect(count.number).toMatch(/^CNT-\d{4}-\d{6}$/);
    expect((await as(officer).post(`/stores/counts/${count.id}/post`, {}, ifMatch(1))).status).toBe(400); // nothing counted yet
    await as(officer).post(`/stores/counts/${count.id}/lines`, { itemId: item.id, countedQty: before - 2 });
    expect((await as(officer).post(`/stores/counts/${count.id}/post`, {}, ifMatch(1))).body.data.adjustments).toBe(1);
    const s = await state();
    expect(onHand(s, item.id, loc.MAIN)).toBe(before - 2);
    expect(s.counts.find((c) => c.id === count.id)).toMatchObject({ status: 'POSTED', lines: [{ itemId: item.id, systemQty: before, countedQty: before - 2 }] });
    expect((await as(officer).post(`/stores/counts/${count.id}/lines`, { itemId: item.id, countedQty: 1 })).status).toBe(409);
  });

  it('keeps roles to their part, and hospitals apart', async () => {
    expect((await as(desk).get('/stores')).status).toBe(403);
    expect((await as(nurse).post('/stores/receipts', { itemId: item.id, locationId: loc.MAIN, qty: 1, unitCostMinor: 1 }, key())).status).toBe(403);
    expect((await as(admin).post('/stores/issues', { itemId: item.id, locationId: loc.MAIN, qty: 1 }, key())).status).toBe(403);
    const other = await state(bOfficer);
    expect(other.items.find((i) => i.id === item.id)).toBeUndefined();
    expect((await as(bOfficer).post('/stores/issues', { itemId: item.id, locationId: other.locations[0].id, qty: 1 }, key())).status).toBe(404);
    const ctx = { organizationId: A.organizationId, userId: officer.userId };
    await expect(withTenant(ctx, (tx) => tx.emrStoreMovement.updateMany({ where: { itemId: item.id }, data: { qtyDelta: 999 } }))).rejects.toThrow();
    await expect(withTenant(ctx, (tx) => tx.emrStoreBatch.updateMany({ where: { itemId: item.id }, data: { unitCostMinor: 1n } }))).rejects.toThrow();
    // a landed cost can only raise a cost, and only on the hospital's own batch
    const batchId = (await state()).batches.find((b) => b.itemId === item.id).id;
    await expect(withTenant(ctx, (tx) => tx.$executeRaw`SELECT emr_raise_batch_cost(${batchId}, ${-500n})`)).rejects.toThrow();
    await expect(withTenant({ organizationId: B.organizationId, userId: bOfficer.userId }, (tx) => tx.$executeRaw`SELECT emr_raise_batch_cost(${batchId}, ${500n})`)).rejects.toThrow();
  });
});
