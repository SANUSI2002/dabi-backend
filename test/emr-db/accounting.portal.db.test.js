// The customer and supplier portal against real Postgres with RLS on: a link shows only its own party's
// statement and documents, never a draft or another party's; only the token's hash is stored; expired,
// revoked or made-up tokens all get the same 404; staff can email a link to a customer.
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant, prisma } from './fixtures.js';

const as = (who) => {
  const url = (path) => `/api/v1/accounting/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}) => request(app).post(url(path)).set('Authorization', who.auth).send(body),
  };
};
const pub = (path) => request(app).get(`/api/v1/accounting/portal/${path}`).buffer(true).parse((res, cb) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
const json = async (path) => { const res = await pub(path); return { status: res.status, headers: res.headers, body: JSON.parse(res.body.toString() || '{}') }; };
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };
const today = () => new Date().toISOString();
const svc = (description, unitPrice) => ({ accountNumber: 4000, description, qty: 1, unitPrice, taxRateId: 'tax-vat-exempt' });

let A; let finance; let viewer; let hmo; let other; let issued; let draft; let otherInv; let link;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });

beforeAll(async () => {
  A = await createTenant('portalA', { modules: ['accounting'] });
  finance = await member(A, ['FINANCE_OFFICER']);
  viewer = await member(A, ['HOSPITAL_ADMIN']);
  hmo = ok(await as(finance).post('/receivables/customers', { name: 'AXA Mansard HMO', type: 'HMO', email: 'claims@axa.test', openingBalance: 120000 }), 201);
  other = ok(await as(finance).post('/receivables/customers', { name: 'Other Corp', type: 'Corporate' }), 201);
  issued = ok(await as(finance).post('/receivables/invoices', { customerId: hmo.id, date: today(), lines: [svc('Admissions — October', 300000)] }), 201);
  ok(await as(finance).post(`/receivables/invoices/${issued.id}/issue`));
  draft = ok(await as(finance).post('/receivables/invoices', { customerId: hmo.id, date: today(), lines: [svc('Not yet', 1000)] }), 201);
  otherInv = ok(await as(finance).post('/receivables/invoices', { customerId: other.id, date: today(), lines: [svc('Someone else', 5000)] }), 201);
  ok(await as(finance).post(`/receivables/invoices/${otherInv.id}/issue`));
});

describe('customer and supplier portal', () => {
  it('creates a link whose token is shown once and stored only as a hash', async () => {
    link = ok(await as(finance).post('/portal-links', { partyKind: 'customer', partyId: hmo.id, days: 30 }), 201);
    expect(link.url).toMatch(/\/portal\/[\w-]{43}$/);
    const row = await prisma.acctPortalLink.findUnique({ where: { id: link.id } });
    expect(row.tokenHash).toBe(createHash('sha256').update(link.token).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(link.token);
    expect((await as(finance).post('/portal-links', { partyKind: 'customer', partyId: hmo.id, days: 365 })).status).toBe(400);
    expect((await as(finance).post('/portal-links', { partyKind: 'vendor', partyId: hmo.id })).status).toBe(404); // not a vendor
  });

  it("shows the customer's own statement and issued invoices, nothing else", async () => {
    const view = await json(link.token);
    expect(view.status).toBe(200);
    expect(view.headers['cache-control']).toBe('no-store');
    expect(view.headers['referrer-policy']).toBe('no-referrer');
    const data = view.body.data;
    expect(data).toMatchObject({ kind: 'customer', party: { name: 'AXA Mansard HMO' } });
    expect(data.statement.closingBalance).toBe(420000); // opening 120,000 + 300,000
    expect(data.invoices.map((i) => i.id)).toEqual([issued.id]); // no draft, no other customer's
    expect(JSON.stringify(data)).not.toContain('Other Corp');
    const pdf = await pub(`${link.token}/invoices/${issued.id}.pdf`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await pub(`${link.token}/invoices/${draft.id}.pdf`)).status).toBe(404);
    expect((await pub(`${link.token}/invoices/${otherInv.id}.pdf`)).status).toBe(404);
    expect((await pub(`${link.token}/statement.pdf`)).headers['content-type']).toBe('application/pdf');
    expect((await pub(`${link.token}/payments/${issued.id}/remittance.pdf`)).status).toBe(404); // a customer link has no remittances
    const listed = ok(await as(viewer).get(`/portal-links?partyKind=customer&partyId=${hmo.id}`));
    expect(listed.items[0]).toMatchObject({ id: link.id, status: 'Active', useCount: 3 }); // only the requests that were served
  });

  it('refuses made-up, revoked and expired tokens alike', async () => {
    const fake = 'A'.repeat(43);
    expect((await json(fake)).status).toBe(404);
    expect((await json('short')).status).toBe(400);
    expect((await as(viewer).post(`/portal-links/${link.id}/revoke`)).status).toBe(403); // viewing is not revoking
    ok(await as(finance).post(`/portal-links/${link.id}/revoke`));
    const gone = await json(link.token);
    expect(gone.status).toBe(404);
    expect(gone.body.error.message).toMatch(/expired or is no longer valid/);
    const soon = ok(await as(finance).post('/portal-links', { partyKind: 'customer', partyId: hmo.id, days: 1 }), 201);
    await prisma.$executeRaw`UPDATE "acct_portal_links" SET "created_at" = now() - interval '3 days', "expires_at" = now() - interval '2 days' WHERE "id" = ${soon.id}`;
    expect((await json(soon.token)).status).toBe(404);
  });

  it('emails a link to a customer, and shows a supplier their bills and remittance advice', async () => {
    expect((await as(finance).post('/portal-links', { partyKind: 'customer', partyId: other.id, email: true })).status).toBe(400); // no email address
    const emailed = ok(await as(finance).post('/portal-links', { partyKind: 'customer', partyId: hmo.id, email: true }), 201);
    expect(emailed.delivery).toEqual({ status: 'NOT_SENT', reason: 'EMAIL_NOT_CONFIGURED' });
    expect(await prisma.acctCustomerNotice.count({ where: { organizationId: A.organizationId, kind: 'portal', customerId: hmo.id } })).toBe(1);

    const vendor = ok(await as(finance).post('/payables/vendors', { name: 'May & Baker', category: 'Pharmaceuticals' }), 201);
    const bill = ok(await as(finance).post('/payables/bills', { vendorId: vendor.id, vendorInvoiceNumber: 'MB-2231', date: today(), lines: [{ accountNumber: 1200, description: 'Paracetamol', qty: 100, unitPrice: 1000, taxRateId: 'tax-vat-exempt' }] }), 201);
    ok(await as(finance).post(`/payables/bills/${bill.id}/submit`));
    const pay = ok(await as(finance).post('/payables/payments', { vendorId: vendor.id, date: today(), method: 'Bank Transfer', fromAccountNumber: 1010, amount: 40000, allocations: [{ billId: bill.id, amount: 40000 }] }), 201);
    const vlink = ok(await as(finance).post('/portal-links', { partyKind: 'vendor', partyId: vendor.id }), 201);
    const v = (await json(vlink.token)).body.data;
    expect(v).toMatchObject({ kind: 'vendor', party: { name: 'May & Baker' }, hospital: { paymentInstructions: '' } });
    expect(v.bills).toEqual([expect.objectContaining({ id: bill.id, yourReference: 'MB-2231', balance: 60000 })]);
    expect(v.statement.closingBalance).toBe(60000);
    expect((await pub(`${vlink.token}/payments/${pay.id}/remittance.pdf`)).headers['content-type']).toBe('application/pdf');
    expect((await pub(`${vlink.token}/invoices/${issued.id}.pdf`)).status).toBe(404);
  });
});
