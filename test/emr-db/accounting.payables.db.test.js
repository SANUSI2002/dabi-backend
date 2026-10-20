// Payables against real Postgres with RLS on: requisitions approved by role (never by their submitter),
// order → goods receipt → bill, bills held for approval above a threshold, payments with withholding tax,
// vendor credits, and the trial balance tying out throughout.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant } from './fixtures.js';

const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const as = (who) => {
  const url = (path) => `/api/v1/accounting/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    patch: (path, body = {}, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };
const today = () => new Date().toISOString();

let A; let finance; let finance2; let controller; let admin; let vendor;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const ap = async (who = finance) => ok(await as(who).get('/payables'));
const tb = async () => ok(await as(finance).get('/ledger/trial-balance'));
const bal = (t, n) => { const r = t.rows.find((x) => x.number === n); return r ? r.debit - r.credit : 0; };
const pl = (accountNumber, description, qty, unitPrice, extra = {}) => ({ accountNumber, description, qty, unitPrice, taxRateId: 'tax-vat-exempt', ...extra });

beforeAll(async () => {
  A = await createTenant('apA', { modules: ['accounting'] });
  finance = await member(A, ['FINANCE_OFFICER']);
  finance2 = await member(A, ['FINANCE_OFFICER']);
  controller = await member(A, ['FINANCE_CONTROLLER']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  vendor = ok(await as(finance).post('/payables/vendors', { name: 'Emzor Pharmaceuticals', category: 'Pharmaceuticals', taxId: '0123-4567', openingBalance: 250000 }), 201);
});

describe('payables', () => {
  it('books vendor opening balances to Accounts Payable', async () => {
    const t = await tb();
    expect(bal(t, 2000)).toBe(-250000);
    expect(bal(t, 3900)).toBe(250000);
  });

  it('approves a requisition by role, never by its submitter, then orders it', async () => {
    // starter rules: ₦250k–₦2m needs an Approver; ₦2m+ adds the Finance Controller
    const pr = ok(await as(finance).post('/payables/requisitions', { date: today(), lines: [pl(1200, 'Artemether-lumefantrine', 500, 3000)], justification: 'Malaria season stock' }), 201);
    ok(await as(finance).post(`/payables/requisitions/${pr.id}/submit`));
    expect((await ap()).requisitions.find((x) => x.id === pr.id)).toMatchObject({ status: 'Pending Approval', approval: { status: 'Pending', submittedByMe: true, decidableByMe: false } });
    expect((await as(finance).post(`/payables/requisitions/${pr.id}/decide`, { decision: 'Approved' })).body.error.code).toBe('OWN_REQUEST');
    expect((await as(finance2).post(`/payables/requisitions/${pr.id}/decide`, { decision: 'Approved' })).status).toBe(403); // an accountant, not an approver
    expect((await ap(admin)).requisitions.find((x) => x.id === pr.id).approval.decidableByMe).toBe(true);
    ok(await as(admin).post(`/payables/requisitions/${pr.id}/decide`, { decision: 'Approved', comment: 'Seasonal' }));
    const po = ok(await as(finance).post(`/payables/requisitions/${pr.id}/convert`, { vendorId: vendor.id }), 201);
    const data = await ap();
    expect(data.requisitions.find((x) => x.id === pr.id)).toMatchObject({ status: 'Ordered', purchaseOrderId: po.id, approval: { status: 'Approved', steps: [expect.objectContaining({ decision: 'Approved', comment: 'Seasonal' })] } });
    expect(data.purchaseOrders.find((x) => x.id === po.id)).toMatchObject({ status: 'Draft', requisitionId: pr.id });
  });

  it('receives goods against a sent order, never beyond what was ordered, then bills it with approval', async () => {
    const po = (await ap()).purchaseOrders[0];
    expect((await as(finance).post(`/payables/purchase-orders/${po.id}/receive`, { received: [{ poLineId: po.lines[0].id, qtyReceived: 1 }] })).status).toBe(409); // not sent yet
    ok(await as(finance).post(`/payables/purchase-orders/${po.id}/status`, { status: 'Sent' }));
    ok(await as(finance).post(`/payables/purchase-orders/${po.id}/receive`, { received: [{ poLineId: po.lines[0].id, qtyReceived: 300 }] }), 201);
    expect((await as(finance).post(`/payables/purchase-orders/${po.id}/receive`, { received: [{ poLineId: po.lines[0].id, qtyReceived: 300 }] })).status).toBe(400);
    ok(await as(finance).post(`/payables/purchase-orders/${po.id}/receive`, { received: [{ poLineId: po.lines[0].id, qtyReceived: 200 }] }), 201);
    expect((await ap()).purchaseOrders.find((x) => x.id === po.id).status).toBe('Received');
    const bill = ok(await as(finance).post(`/payables/purchase-orders/${po.id}/bill`), 201);
    // ₦1.5m: the starter bill rules want an Accountant (₦500k–₦3m) — not the one who submitted it
    ok(await as(finance).post(`/payables/bills/${bill.id}/submit`));
    expect(bal(await tb(), 1200)).toBe(0); // nothing posts until approved
    expect((await as(finance).post(`/payables/bills/${bill.id}/decide`, { decision: 'Approved' })).body.error.code).toBe('OWN_REQUEST');
    ok(await as(finance2).post(`/payables/bills/${bill.id}/decide`, { decision: 'Approved' }));
    const t = await tb();
    expect(bal(t, 1200)).toBe(1500000);
    expect(bal(t, 2000)).toBe(-1750000);
    expect(t.inBalance).toBe(true);
  });

  it('pays bills with withholding tax and settles only what is owed', async () => {
    const bill = (await ap()).bills.find((b) => b.status === 'Awaiting Payment');
    expect((await as(finance).post('/payables/payments', { vendorId: vendor.id, date: today(), method: 'Bank Transfer', fromAccountNumber: 1010, amount: 2000000, allocations: [{ billId: bill.id, amount: 2000000 }] })).status).toBe(400);
    expect((await as(finance).post('/payables/payments', { vendorId: vendor.id, date: today(), method: 'Bank Transfer', fromAccountNumber: 1100, amount: 1, allocations: [] })).status).toBe(400); // not a bank account
    // ₦1.5m bill, 5% WHT withheld: ₦1,425,000 leaves the bank, ₦75,000 owed to the tax office
    ok(await as(finance).post('/payables/payments', { vendorId: vendor.id, date: today(), method: 'Bank Transfer', fromAccountNumber: 1010, amount: 1425000, withheldTax: 75000, allocations: [{ billId: bill.id, amount: 1500000 }], reference: 'NIP-778' }), 201);
    const data = await ap();
    expect(data.bills.find((b) => b.id === bill.id)).toMatchObject({ status: 'Paid', amountPaid: 1500000 });
    expect(data.vendorPayments[0]).toMatchObject({ amount: 1425000, withheldTax: 75000 });
    const t = await tb();
    expect(bal(t, 2000)).toBe(-250000);
    expect(bal(t, 2210)).toBe(-75000);
    expect(bal(t, 1010)).toBe(-1425000);
    expect(t.inBalance).toBe(true);
  });

  it('applies vendor credits and voids only unpaid bills', async () => {
    const big = ok(await as(finance).post('/payables/bills', { vendorId: vendor.id, date: today(), lines: [pl(5230, 'Generator service', 1, 120000)] }), 201);
    ok(await as(finance).post(`/payables/bills/${big.id}/submit`)); // under every threshold: posts at once
    const vc = ok(await as(finance).post('/payables/vendor-credits', { vendorId: vendor.id, billId: big.id, date: today(), lines: [pl(5230, 'Part not fitted', 1, 20000)], reason: 'Part returned' }), 201);
    expect((await as(finance).post(`/payables/vendor-credits/${vc.id}/apply`, { billId: big.id, amount: 30000 })).status).toBe(400);
    ok(await as(finance).post(`/payables/vendor-credits/${vc.id}/apply`, { billId: big.id, amount: 20000 }));
    expect((await as(finance).post(`/payables/bills/${big.id}/void`)).body.error.message).toMatch(/Un-apply payments/);
    const draft = ok(await as(finance).post('/payables/bills', { vendorId: vendor.id, date: today(), lines: [pl(5300, 'Stationery', 1, 5000)] }), 201);
    ok(await as(finance).post(`/payables/bills/${draft.id}/void`));
    const data = await ap();
    expect(data.vendorCredits.find((x) => x.id === vc.id)).toMatchObject({ status: 'Applied', applications: [expect.objectContaining({ billId: big.id, amount: 20000 })] });
    expect(data.bills.find((b) => b.id === big.id)).toMatchObject({ amountPaid: 20000, status: 'Partially Paid' });
    expect((await tb()).inBalance).toBe(true);
  });

  it('lets the controller tune approval rules', async () => {
    const rules = ok(await as(finance).get('/ledger')).approvalRules;
    const billRule = rules.find((r) => r.docType === 'Bill' && r.level === 1);
    expect((await as(finance).patch(`/approval-rules/${billRule.id}`, { active: false }, ifMatch(billRule.version))).status).toBe(403);
    ok(await as(controller).patch(`/approval-rules/${billRule.id}`, { active: false }, ifMatch(billRule.version)));
    ok(await as(controller).post('/approval-rules', { docType: 'Bill', minAmount: 100000, maxAmount: 500000, approverRole: 'Approver', level: 1 }), 201);
    const b = ok(await as(finance).post('/payables/bills', { vendorId: vendor.id, date: today(), lines: [pl(5230, 'Service', 1, 200000)] }), 201);
    expect(ok(await as(finance).post(`/payables/bills/${b.id}/submit`)).status).toBe('Pending Approval');
  });
});
