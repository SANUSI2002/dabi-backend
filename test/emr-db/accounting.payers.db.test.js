// Healthcare payers and credit risk against real Postgres with RLS on: billing an HMO for a patient's
// charges (and reversing it), claims submitted and adjudicated with denials written off or billed back
// to the patient, capitation recognized month by month, the expected-credit-loss allowance, write-offs
// and recoveries — with the trial balance tying out throughout.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant } from './fixtures.js';

const as = (who) => {
  const url = (path) => `/api/v1/accounting/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}) => request(app).post(url(path)).set('Authorization', who.auth).send(body),
  };
};
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };
const today = () => new Date().toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const svc = (description, unitPrice) => ({ accountNumber: 4000, description, qty: 1, unitPrice, taxRateId: 'tax-vat-exempt' });
const ym = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

let A; let finance; let controller; let hmo; let ada; let bisi; let inv1; let inv2;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const ar = async () => ok(await as(finance).get('/receivables'));
const payers = async () => ok(await as(finance).get('/receivables/payers'));
const tb = async () => ok(await as(finance).get('/ledger/trial-balance'));
const bal = (t, n) => { const r = t.rows.find((x) => x.number === n); return r ? r.debit - r.credit : 0; };
const invoice = async (customerId, description, amount, date = today()) => {
  const inv = ok(await as(finance).post('/receivables/invoices', { customerId, date, lines: [svc(description, amount)] }), 201);
  ok(await as(finance).post(`/receivables/invoices/${inv.id}/issue`));
  return inv;
};
const doc = async (id) => (await ar()).invoices.find((i) => i.id === id);

beforeAll(async () => {
  A = await createTenant('payersA', { modules: ['accounting'] });
  finance = await member(A, ['FINANCE_OFFICER']);
  controller = await member(A, ['FINANCE_CONTROLLER']);
  hmo = ok(await as(finance).post('/receivables/customers', { name: 'Reliance HMO', type: 'HMO' }), 201);
  ada = ok(await as(finance).post('/receivables/customers', { name: 'Ada Okafor', type: 'Patient' }), 201);
  bisi = ok(await as(finance).post('/receivables/customers', { name: 'Bisi Ade', type: 'Patient' }), 201);
});

describe('healthcare payers', () => {
  it("bills a patient's charges to their HMO, and reverses an untouched transfer", async () => {
    inv1 = await invoice(ada.id, 'Admission — 3 days', 100000);
    expect((await as(finance).post(`/receivables/invoices/${inv1.id}/bill-payer`, { payerId: bisi.id })).status).toBe(400); // not a payer
    expect((await as(finance).post(`/receivables/invoices/${inv1.id}/bill-payer`, { payerId: hmo.id, amount: 150000 })).status).toBe(400); // more than is owed
    const t = ok(await as(finance).post(`/receivables/invoices/${inv1.id}/bill-payer`, { payerId: hmo.id, amount: 80000, authorizationCode: 'RL-55821', enrolleeNumber: 'ENR-0091' }), 201);
    expect(await doc(inv1.id)).toMatchObject({ status: 'Partially Paid', amountPaid: 80000 });
    expect(await doc(t.payerInvoiceId)).toMatchObject({ customerId: hmo.id, status: 'Open', lines: [expect.objectContaining({ description: 'Ada Okafor — ' + (await doc(inv1.id)).number + ' (auth RL-55821 · enrollee ENR-0091)', unitPrice: 80000 })] });
    let t1 = await tb();
    expect(bal(t1, 1100)).toBe(20000);
    expect(bal(t1, 1120)).toBe(80000);
    expect((await as(finance).post(`/receivables/void/invoice/${t.payerInvoiceId}`)).body.error.message).toMatch(/reverse the transfer/);
    ok(await as(finance).post(`/receivables/payer-transfers/${t.id}/reverse`));
    expect(await doc(inv1.id)).toMatchObject({ status: 'Open', amountPaid: 0 });
    expect((await doc(t.payerInvoiceId)).status).toBe('Void');
    t1 = await tb();
    expect(bal(t1, 1120)).toBe(0);
    expect((await as(finance).post(`/receivables/payer-transfers/${t.id}/reverse`)).status).toBe(409);
    // billed again for real
    ok(await as(finance).post(`/receivables/invoices/${inv1.id}/bill-payer`, { payerId: hmo.id, amount: 80000, authorizationCode: 'RL-55821' }), 201);
    inv2 = await invoice(bisi.id, 'Caesarean section', 50000);
    ok(await as(finance).post(`/receivables/invoices/${inv2.id}/bill-payer`, { payerId: hmo.id }), 201);
    expect((await doc(inv2.id)).status).toBe('Paid');
    expect((await tb()).inBalance).toBe(true);
  });

  it('claims the payer\'s invoices, and books denials as write-offs or patient rebills', async () => {
    const start = daysAgo(1).slice(0, 10); const end = today().slice(0, 10);
    const claim = ok(await as(finance).post('/receivables/claims', { payerId: hmo.id, periodStart: start, periodEnd: end }), 201);
    expect(claim).toMatchObject({ number: expect.stringMatching(/^CLM-\d{4}-000001$/), claimed: 130000 });
    expect((await as(finance).post('/receivables/claims', { payerId: hmo.id, periodStart: start, periodEnd: end })).status).toBe(400); // all on the open claim
    let c = (await payers()).claims.find((x) => x.id === claim.id);
    expect((await as(finance).post(`/receivables/claims/${claim.id}/adjudicate`, { items: [] })).status).toBe(400);
    expect((await as(finance).post(`/receivables/claims/${claim.id}/adjudicate`, { items: c.items.map((i) => ({ invoiceId: i.invoiceId, approved: i.claimed })) })).status).toBe(409); // not submitted yet
    ok(await as(finance).post(`/receivables/claims/${claim.id}/submit`, { reference: 'RL-BATCH-2026-10' }));
    const [first, second] = c.items; // 80,000 (Ada's) and 50,000 (Bisi's)
    expect((await as(finance).post(`/receivables/claims/${claim.id}/adjudicate`, { items: [{ invoiceId: first.invoiceId, approved: 90000 }, { invoiceId: second.invoiceId, approved: 0 }] })).status).toBe(400); // over the claim
    const result = ok(await as(finance).post(`/receivables/claims/${claim.id}/adjudicate`, { items: [
      { invoiceId: first.invoiceId, approved: 70000, reason: 'Excess bed days', action: 'write-off' },
      { invoiceId: second.invoiceId, approved: 40000, reason: 'Not covered: consumables', action: 'rebill' },
    ] }));
    expect(result).toMatchObject({ approved: 110000, denied: 20000 });
    c = (await payers()).claims.find((x) => x.id === claim.id);
    expect(c).toMatchObject({ status: 'Adjudicated', approved: 110000, denied: 20000, reference: 'RL-BATCH-2026-10' });
    expect(await doc(inv2.id)).toMatchObject({ status: 'Partially Paid', amountPaid: 40000 }); // Bisi owes the 10,000 denied
    const t = await tb();
    expect(bal(t, 4910)).toBe(10000);
    expect(bal(t, 1120)).toBe(110000);
    expect(bal(t, 1100)).toBe(30000); // Ada's 20,000 + Bisi's 10,000
    // the payer pays what it approved
    const owed = (await ar()).invoices.filter((i) => i.customerId === hmo.id && i.status !== 'Void' && i.status !== 'Paid');
    ok(await as(finance).post('/receivables/receipts', { customerId: hmo.id, date: today(), method: 'Bank Transfer', depositAccountNumber: 1010, amount: 110000, allocations: owed.map((i) => ({ invoiceId: i.id, amount: i.id === first.invoiceId ? 70000 : 40000 })) }), 201);
    expect(bal(await tb(), 1120)).toBe(0);
    expect((await tb()).inBalance).toBe(true);
  });

  it('recognizes capitation month by month', async () => {
    const now = new Date(); const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const cap = ok(await as(finance).post('/receivables/capitation', { payerId: hmo.id, startPeriod: ym(last), months: 3, enrollees: 100, ratePerEnrollee: 750, receivedDate: today().slice(0, 10), depositAccountNumber: 1010, reference: 'RL-CAP-Q4' }), 201);
    expect(cap).toMatchObject({ number: expect.stringMatching(/^CAP-/), amount: 225000, recognized: 150000, deferred: 75000 });
    let t = await tb();
    expect(bal(t, 4060)).toBe(-150000);
    expect(bal(t, 2400)).toBe(-75000);
    expect(ok(await as(finance).post('/receivables/capitation/recognize', { asOf: today() }))).toEqual({ months: 0, amount: 0 }); // next month has not begun
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2)).toISOString();
    expect(ok(await as(finance).post('/receivables/capitation/recognize', { asOf: next }))).toEqual({ months: 1, amount: 75000 });
    t = await tb();
    expect(bal(t, 4060)).toBe(-225000);
    expect(bal(t, 2400)).toBe(0);
    expect((await payers()).capitations[0].entries.every((e) => e.recognized)).toBe(true);
    expect(t.inBalance).toBe(true);
  });

  it('measures the allowance from the provision matrix and writes off what is uncollectable', async () => {
    // an old patient balance: 120 days overdue
    const old = await invoice(bisi.id, 'Emergency care', 60000, daysAgo(150));
    const rates = { patient: [2, 5, 15, 30, 50], payer: [1, 2, 5, 15, 35] };
    const preview = ok(await as(finance).post('/receivables/credit-loss', { rates }));
    expect(preview.previous).toBe(0);
    const over90 = preview.buckets.find((b) => b.group === 'patient' && b.band === 'Over 90 days');
    expect(over90).toMatchObject({ balance: 60000, rate: 50, expected: 30000 });
    expect(bal(await tb(), 1190)).toBe(0); // a preview posts nothing
    expect((await as(finance).post('/receivables/credit-loss', { rates, post: true })).status).toBe(403); // posting needs approval rights
    const run = ok(await as(controller).post('/receivables/credit-loss', { rates, post: true }));
    expect(run.adjustment).toBe(preview.required);
    let t = await tb();
    expect(bal(t, 1190)).toBe(-preview.required);
    expect(bal(t, 5700)).toBe(preview.required);
    // the same measure again changes nothing
    expect(ok(await as(controller).post('/receivables/credit-loss', { rates, post: true }))).toMatchObject({ adjustment: 0 });

    expect((await as(finance).post(`/receivables/invoices/${old.id}/write-off`, { reason: 'Patient untraceable' })).status).toBe(403);
    const w = ok(await as(controller).post(`/receivables/invoices/${old.id}/write-off`, { reason: 'Patient untraceable after 150 days' }), 201);
    expect(w).toMatchObject({ amount: 60000, fromAllowance: preview.required, toExpense: 60000 - preview.required });
    expect((await doc(old.id)).status).toBe('Written Off');
    ok(await as(finance).post(`/receivables/write-offs/${w.id}/recover`, { amount: 5000, depositAccountNumber: 1000 }));
    expect((await as(finance).post(`/receivables/write-offs/${w.id}/recover`, { amount: 60000, depositAccountNumber: 1000 })).status).toBe(400);
    t = await tb();
    expect(bal(t, 4120)).toBe(-5000);
    expect(bal(t, 1190)).toBe(0);
    expect((await payers()).writeOffs[0]).toMatchObject({ recoveredAmount: 5000, reason: 'Patient untraceable after 150 days' });
    expect(t.inBalance).toBe(true);
  });
});
