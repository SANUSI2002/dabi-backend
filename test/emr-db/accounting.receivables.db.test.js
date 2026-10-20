// Receivables against real Postgres with RLS on: customers and opening balances, quotation → order →
// invoice, issuing with VAT and the stacked levy, credit control, receipts with early-pay discount and
// FX, credit notes applied and refunded, cash-sale and refund receipts, delayed charges, deferred revenue,
// recurring invoices, reminders and statements — with the trial balance tying out throughout.
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
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

let A; let finance; let controller; let admin; let hmo; let patient;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const ar = async () => ok(await as(finance).get('/receivables'));
const tb = async () => ok(await as(finance).get('/ledger/trial-balance'));
const bal = (t, n) => { const r = t.rows.find((x) => x.number === n); return r ? r.debit - r.credit : 0; };
const svc = (accountNumber, description, qty, unitPrice, extra = {}) => ({ accountNumber, description, qty, unitPrice, taxRateId: 'tax-vat-exempt', ...extra });

beforeAll(async () => {
  A = await createTenant('arA', { modules: ['accounting'] });
  finance = await member(A, ['FINANCE_OFFICER']);
  controller = await member(A, ['FINANCE_CONTROLLER']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
});

describe('receivables', () => {
  it('adds customers to the right receivable account, opening balances as journal entries', async () => {
    hmo = ok(await as(finance).post('/receivables/customers', { name: 'Hygeia HMO', type: 'HMO', email: 'claims@hygeia.test', paymentTermId: 'pt-2-10-30', openingBalance: 500000 }), 201);
    patient = ok(await as(finance).post('/receivables/customers', { name: 'Ada Obi', type: 'Patient' }), 201);
    expect((await as(finance).post('/receivables/customers', { name: 'X', type: 'Corporate', creditLimit: 100 })).status).toBe(403); // credit limits need approval rights
    const data = await ar();
    expect(data.customers.find((c) => c.id === hmo.id)).toMatchObject({ arAccountNumber: 1120, paymentTermId: 'pt-2-10-30' });
    const t = await tb();
    expect(bal(t, 1120)).toBe(500000);
    expect(bal(t, 3900)).toBe(-500000);
  });

  it('turns a quotation into an order and an invoice, and issues it with VAT and the levy', async () => {
    const est = ok(await as(finance).post('/receivables/estimates', { customerId: hmo.id, date: today(), expiryDays: 14, lines: [svc(4010, 'Lab panel', 10, 20000, { taxRateIds: ['tax-vat-standard', 'tax-levy-1'], taxRateId: undefined })] }), 201);
    expect(est.number).toMatch(/^EST-\d{4}-000001$/);
    ok(await as(finance).post(`/receivables/estimates/${est.id}/status`, { status: 'Sent' }));
    ok(await as(finance).post(`/receivables/estimates/${est.id}/status`, { status: 'Accepted' }));
    const so = ok(await as(finance).post(`/receivables/estimate/${est.id}/convert`, { to: 'sales-order' }), 201);
    expect((await as(finance).post(`/receivables/estimate/${est.id}/convert`, { to: 'invoice' })).status).toBe(409); // already converted
    ok(await as(finance).post(`/receivables/sales-orders/${so.id}/status`, { status: 'Confirmed' }));
    const inv = ok(await as(finance).post(`/receivables/sales-order/${so.id}/convert`, { to: 'invoice' }), 201);
    ok(await as(finance).post(`/receivables/invoices/${inv.id}/issue`));
    expect((await as(finance).post(`/receivables/invoices/${inv.id}/issue`)).status).toBe(409);
    const data = await ar();
    const issued = data.invoices.find((i) => i.id === inv.id);
    expect(issued).toMatchObject({ status: 'Open', salesOrderId: so.id, journalEntryId: expect.any(String) });
    const t = await tb();
    expect(bal(t, 1120)).toBe(500000 + 217000); // 200,000 + VAT 15,000 + levy 2,000
    expect(bal(t, 4010)).toBe(-200000);
    expect(bal(t, 2200)).toBe(-15000);
    expect(bal(t, 2220)).toBe(-2000);
    expect(t.inBalance).toBe(true);
  });

  it('holds and limits credit, with approval to go over the limit', async () => {
    const c = (await ar()).customers.find((x) => x.id === patient.id);
    expect((await as(finance).patch(`/receivables/customers/${patient.id}`, { creditLimit: 50000 }, ifMatch(c.version))).status).toBe(403);
    ok(await as(admin).patch(`/receivables/customers/${patient.id}`, { creditLimit: 50000 }, ifMatch(c.version)));
    const big = ok(await as(finance).post('/receivables/invoices', { customerId: patient.id, date: today(), lines: [svc(4040, 'Admission', 3, 30000)] }), 201);
    expect((await as(finance).post(`/receivables/invoices/${big.id}/issue`)).body.error.message).toMatch(/against a 50,000 limit/);
    expect((await as(finance).post(`/receivables/invoices/${big.id}/issue`, { overrideCredit: true })).status).toBe(403);
    ok(await as(controller).post(`/receivables/invoices/${big.id}/issue`, { overrideCredit: true }));
    const c2 = (await ar()).customers.find((x) => x.id === patient.id);
    ok(await as(admin).patch(`/receivables/customers/${patient.id}`, { creditHold: true }, ifMatch(c2.version)));
    const held = ok(await as(finance).post('/receivables/invoices', { customerId: patient.id, date: today(), lines: [svc(4000, 'Consult', 1, 5000)] }), 201);
    expect((await as(controller).post(`/receivables/invoices/${held.id}/issue`, { overrideCredit: true })).body.error.message).toMatch(/credit hold/);
    ok(await as(finance).post(`/receivables/void/invoice/${held.id}`));
  });

  it('records receipts against the customer\'s own invoices, with an early-payment discount', async () => {
    const data = await ar();
    const inv = data.invoices.find((i) => i.customerId === hmo.id && i.status === 'Open');
    const other = data.invoices.find((i) => i.customerId === patient.id && i.status === 'Open');
    expect((await as(finance).post('/receivables/receipts', { customerId: hmo.id, date: today(), method: 'Bank Transfer', depositAccountNumber: 1010, amount: 1000, allocations: [{ invoiceId: other.id, amount: 1000 }] })).status).toBe(400);
    expect((await as(finance).post('/receivables/receipts', { customerId: hmo.id, date: today(), method: 'Bank Transfer', depositAccountNumber: 1010, amount: 300000, allocations: [{ invoiceId: inv.id, amount: 300000 }] })).body.error.message).toMatch(/more than the 217,000/);
    // 2/10 net 30: 2% of 217,000 = 4,340 off when paid within 10 days
    expect((await as(finance).post('/receivables/receipts', { customerId: hmo.id, date: today(), method: 'Bank Transfer', depositAccountNumber: 1010, amount: 200000, allocations: [{ invoiceId: inv.id, amount: 200000, discount: 17000 }] })).status).toBe(400);
    ok(await as(finance).post('/receivables/receipts', { customerId: hmo.id, date: today(), method: 'Bank Transfer', depositAccountNumber: 1010, amount: 212660, allocations: [{ invoiceId: inv.id, amount: 212660, discount: 4340 }], reference: 'NIP-2231' }), 201);
    const after = (await ar()).invoices.find((i) => i.id === inv.id);
    expect(after).toMatchObject({ status: 'Paid', amountPaid: 217000 });
    const t = await tb();
    expect(bal(t, 1120)).toBe(500000);
    expect(bal(t, 4900)).toBe(4340);
    expect(bal(t, 1010)).toBe(212660);
    expect(t.inBalance).toBe(true);
  });

  it('applies and refunds credit notes within what is left', async () => {
    const inv = (await ar()).invoices.find((i) => i.customerId === patient.id && i.status === 'Open');
    const cn = ok(await as(finance).post('/receivables/credit-notes', { customerId: patient.id, invoiceId: inv.id, date: today(), lines: [svc(4040, 'Bed day not used', 1, 30000)], reason: 'Discharged early' }), 201);
    expect((await as(finance).post(`/receivables/credit-notes/${cn.id}/apply`, { invoiceId: inv.id, amount: 40000 })).status).toBe(400);
    ok(await as(finance).post(`/receivables/credit-notes/${cn.id}/apply`, { invoiceId: inv.id, amount: 20000 }));
    ok(await as(finance).post(`/receivables/credit-notes/${cn.id}/refund`, { amount: 10000, fromAccountNumber: 1000 }));
    expect((await as(finance).post(`/receivables/credit-notes/${cn.id}/refund`, { amount: 1, fromAccountNumber: 1000 })).status).toBe(409);
    const data = await ar();
    expect(data.creditNotes.find((x) => x.id === cn.id)).toMatchObject({ status: 'Refunded', refundedAmount: 10000, applications: [expect.objectContaining({ invoiceId: inv.id, amount: 20000 })] });
    expect(data.invoices.find((i) => i.id === inv.id)).toMatchObject({ amountPaid: 20000, status: 'Partially Paid' });
    expect((await tb()).inBalance).toBe(true);
  });

  it('records cash sales and refunds, and voids them by reversal', async () => {
    const sr = ok(await as(finance).post('/receivables/sales-receipts', { customerName: 'Walk-in', date: today(), method: 'POS', depositAccountNumber: 1010, lines: [svc(4020, 'Pharmacy sale', 2, 2500)] }), 201);
    const before = bal(await tb(), 4020);
    expect(before).toBe(-5000);
    ok(await as(finance).post(`/receivables/void/sales-receipt/${sr.id}`));
    expect(bal(await tb(), 4020)).toBe(0);
    ok(await as(finance).post('/receivables/refund-receipts', { customerId: patient.id, date: today(), method: 'Cash', fromAccountNumber: 1000, lines: [svc(4000, 'Consult refund', 1, 3000)], reason: 'Doctor unavailable' }), 201);
    expect((await tb()).inBalance).toBe(true);
  });

  it('bills delayed charges, defers revenue and recognises it month by month', async () => {
    const ch = ok(await as(finance).post('/receivables/delayed-charges', { customerId: hmo.id, date: today(), accountNumber: 4000, description: 'Follow-up visits', qty: 4, unitPrice: 10000 }), 201);
    const inv = ok(await as(finance).post('/receivables/invoices', { customerId: hmo.id, date: daysAgo(40), lines: [], delayedChargeIds: [ch.id], deferOverMonths: 2 }), 201);
    expect((await as(finance).post('/receivables/delayed-charges/' + ch.id + '/remove')).status).toBe(409); // billed now
    ok(await as(finance).post(`/receivables/invoices/${inv.id}/issue`));
    let data = await ar();
    const sch = data.revenueSchedules.find((s) => s.invoiceId === inv.id);
    expect(sch.entries.map((e) => e.amount)).toEqual([20000, 20000]);
    expect(bal(await tb(), 2400)).toBe(-40000);
    ok(await as(finance).post(`/receivables/revenue-schedules/${sch.id}/recognize`, { period: sch.entries[0].period }));
    expect((await as(finance).post(`/receivables/revenue-schedules/${sch.id}/recognize`, { period: sch.entries[0].period })).status).toBe(409);
    expect(bal(await tb(), 2400)).toBe(-20000);
    data = await ar();
    expect(data.delayedCharges.find((c) => c.id === ch.id)).toMatchObject({ status: 'Invoiced', invoiceId: inv.id });
  });

  it('runs recurring invoices and records reminders and statements once each', async () => {
    const tmpl = ok(await as(finance).post('/receivables/invoices', { customerId: hmo.id, date: daysAgo(65), lines: [svc(4000, 'Retainer', 1, 15000)], recurEveryMonths: 1 }), 201);
    ok(await as(finance).post(`/receivables/invoices/${tmpl.id}/issue`));
    const run = ok(await as(finance).post('/receivables/invoices/recurring/run', { asOf: today() }));
    expect(run.created).toHaveLength(2);
    expect(ok(await as(finance).post('/receivables/invoices/recurring/run', { asOf: today() })).created).toHaveLength(0);
    const overdue = (await ar()).invoices.find((i) => i.id === tmpl.id);
    expect(overdue.status).toBe('Overdue');
    ok(await as(finance).post(`/receivables/invoices/${tmpl.id}/reminder`));
    expect(ok(await as(finance).post('/receivables/reminders/run')).sent).toBeGreaterThanOrEqual(0);
    expect((await as(finance).post(`/receivables/invoices/${tmpl.id}/reminder`)).status).toBe(409); // that level is recorded
    expect((await as(finance).post(`/receivables/customers/${patient.id}/statement`)).status).toBe(400); // no email on file
    ok(await as(finance).post(`/receivables/customers/${hmo.id}/statement`));
    const data = await ar();
    expect(data.reminders.some((r) => r.invoiceId === tmpl.id && r.level >= 1)).toBe(true);
    expect(data.statementLog[0]).toMatchObject({ customerId: hmo.id, to: 'claims@hygeia.test' });
    expect((await tb()).inBalance).toBe(true);
  });

  it('voids only unpaid invoices and keeps numbering per organization', async () => {
    const paid = (await ar()).invoices.find((i) => i.status === 'Paid');
    expect((await as(finance).post(`/receivables/void/invoice/${paid.id}`)).body.error.message).toMatch(/Un-apply receipts/);
    const numbers = (await ar()).invoices.map((i) => i.number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});
