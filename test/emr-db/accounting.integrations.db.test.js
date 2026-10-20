// Integrations against real Postgres with RLS on, fed by real EMR flows: an invoiced visit (with a
// discount) becomes a receivables invoice for the patient, its payment a receipt and its reversal a voided
// receipt; confirmed then paid payslips accrue and settle payroll; a dispense relieves drug inventory at
// the batch's cost. Every sync can be repeated without posting twice, and the trial balance ties out
// throughout.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant, newPatient, prisma } from './fixtures.js';

const year = new Date().getUTCFullYear();
const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const api = (base) => (who) => {
  const url = (path) => `/api/v1/${base}/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};
const emr = api('emr');
const acct = api('accounting');
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };

let A; let finance; let supervisor; let doctor; let pharmacist; let invoice;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const sync = async (modules) => ok(await acct(finance).post('/integrations/sync', modules ? { modules } : {}));
const tb = async () => ok(await acct(finance).get('/ledger/trial-balance'));
const bal = (t, n) => { const r = t.rows.find((x) => x.number === n); return r ? r.debit - r.credit : 0; };
const receivables = async () => ok(await acct(finance).get('/receivables'));

beforeAll(async () => {
  A = await createTenant('intA', { modules: ['emr', 'accounting'] });
  finance = await member(A, ['FINANCE_OFFICER']);
  supervisor = await member(A, ['FINANCE_OFFICER', 'HOSPITAL_ADMIN']);
  doctor = await member(A, ['DOCTOR']);
  pharmacist = await member(A, ['PHARMACIST']);
  ok(await emr(finance).post('/billing/prices', { category: 'CONSULTATION', reference: 'OUTPATIENT', name: 'Outpatient consultation', unitPriceMinor: 500_000 }), 201);
  ok(await emr(finance).post('/billing/prices', { category: 'MEDICATION', reference: 'AMLO5', name: 'Amlodipine 5 mg (tablet)', unitPriceMinor: 5_000 }), 201);
  // a visit: consultation + 30 tablets dispensed from a costed batch (₦20 a tablet)
  const patient = ok(await emr(A).post('/patients', newPatient()), 201);
  const encounter = ok(await emr(doctor).post('/encounters', { patientId: patient.id }), 201);
  await emr(doctor).post(`/encounters/${encounter.id}/start`, {}, ifMatch(1));
  await emr(pharmacist).post('/pharmacy/stock/receipts', { formularyCode: 'AMLO5', batchNumber: 'B-COSTED', expiryDate: `${year + 2}-01-31`, quantity: 30, unitCostMinor: 2_000 }, key());
  const rx = (await emr(doctor).post(`/encounters/${encounter.id}/prescriptions`, { items: [{ drugCode: 'AMLO5', dose: 5, doseUnit: 'mg', frequency: 'OD', durationDays: 30 }] })).body.data;
  await emr(pharmacist).post(`/pharmacy/prescriptions/${rx.id}/approve`, {}, ifMatch(1));
  ok(await emr(pharmacist).post(`/pharmacy/prescriptions/${rx.id}/dispense`, { lines: [{ itemId: rx.items[0].id, quantity: 30 }] }, key()), 201);
  ok(await emr(finance).post(`/billing/encounters/${encounter.id}/capture`));
  invoice = ok(await emr(supervisor).post(`/billing/encounters/${encounter.id}/invoices`, { discountMinor: 50_000, discountReason: 'Staff family' }), 201);
});

describe('EMR billing → receivables', () => {
  it('reports what is waiting, and posts each EMR invoice once for its patient', async () => {
    expect(ok(await acct(finance).get('/integrations')).pending).toMatchObject({ emrBilling: 1, pharmacy: 1 });
    expect((await acct(A).post('/integrations/sync', {})).status).toBe(403); // the admin approves, finance posts
    const first = await sync(['EMR Billing']);
    expect(first.results[0]).toMatchObject({ module: 'EMR Billing', created: 1, errors: [] });
    expect((await sync(['EMR Billing'])).results[0].created).toBe(0); // again: nothing twice
    const data = await receivables();
    expect(data.customers).toHaveLength(1);
    expect(data.customers[0]).toMatchObject({ type: 'Patient', name: expect.stringMatching(/ — /) });
    const inv = data.invoices[0];
    expect(inv).toMatchObject({ source: 'EMR Billing', emrInvoiceId: invoice.id, status: expect.stringMatching(/Open|Overdue/) }); // no due date in EMR: due on receipt
    const t = await tb();
    expect(bal(t, 1100)).toBe(6000); // ₦5,000 consultation + ₦1,500 tablets − ₦500 discount
    expect(bal(t, 4000)).toBe(-5000);
    expect(bal(t, 4020)).toBe(-1500);
    expect(bal(t, 4900)).toBe(500);
    expect(t.inBalance).toBe(true);
  });

  it('turns a payment into a receipt and its reversal into a voided receipt', async () => {
    const payment = ok(await emr(finance).post(`/billing/invoices/${invoice.id}/payments`, { amountMinor: 600_000, method: 'CASH' }, key()), 201);
    expect((await sync(['EMR Billing'])).results[0].created).toBe(1);
    expect((await receivables()).invoices[0].status).toBe('Paid');
    expect(bal(await tb(), 1000)).toBe(6000);
    ok(await emr(supervisor).post(`/billing/payments/${payment.id}/reverse`, { reason: 'Counterfeit note' }));
    expect((await sync(['EMR Billing'])).results[0].created).toBe(1);
    const data = await receivables();
    expect(data.receipts).toHaveLength(0);
    expect(data.invoices[0].status).toMatch(/Open|Overdue/);
    const t = await tb();
    expect(bal(t, 1000)).toBe(0);
    expect(bal(t, 1100)).toBe(6000);
  });
});

describe('payroll and pharmacy → ledger', () => {
  it('accrues confirmed payslips per batch and settles them once paid', async () => {
    const nurse = await prisma.wfEmployee.create({ data: { organizationId: A.organizationId, name: 'Amaka Obi', role: 'Nurse', hireDate: new Date('2024-01-01') } });
    const porter = await prisma.wfEmployee.create({ data: { organizationId: A.organizationId, name: 'Musa Ade', role: 'Porter', hireDate: new Date('2024-01-01') } });
    const slip = (status, employee = nurse) => prisma.wfPayslip.create({
      data: {
        organizationId: A.organizationId, employeeId: employee.id, batch: 'Oct 2026', startDate: new Date(`${year}-10-01`), endDate: new Date(`${year}-10-31`), basicSalary: 300000, allowances: [],
        deductions: [{ name: 'PAYE', amount: 30000 }, { name: 'Pension (employee)', amount: 24000 }, { name: 'Union dues', amount: 1000 }], grossPay: 300000, totalDeductions: 55000, netPay: 245000,
        status, generatedByUserId: finance.userId, confirmedByUserId: supervisor.userId, confirmedAt: new Date(), ...(status === 'Paid' ? { paidByUserId: supervisor.userId, paidAt: new Date() } : {}),
      },
    });
    const s1 = await slip('Confirmed');
    await slip('Draft', porter); // not yet
    expect((await sync(['Payroll'])).results[0].created).toBe(1);
    let t = await tb();
    expect(bal(t, 5100)).toBe(300000);
    expect(bal(t, 2300)).toBe(-30000);
    expect(bal(t, 2310)).toBe(-24000);
    expect(bal(t, 2100)).toBe(-1000);
    expect(bal(t, 2120)).toBe(-245000);
    await prisma.wfPayslip.update({ where: { id: s1.id }, data: { status: 'Paid', paidByUserId: supervisor.userId, paidAt: new Date() } });
    expect((await sync(['Payroll'])).results[0].created).toBe(1);
    expect((await sync(['Payroll'])).results[0].created).toBe(0);
    t = await tb();
    expect(bal(t, 2120)).toBe(0);
    expect(t.inBalance).toBe(true);
  });

  it('relieves drug inventory at the batch cost, once', async () => {
    const r = (await sync(['Pharmacy'])).results[0];
    expect(r).toMatchObject({ created: 1, errors: [] });
    const t = await tb();
    expect(bal(t, 5000)).toBe(600); // 30 tablets × ₦20
    expect(bal(t, 1200)).toBe(-600);
    expect((await sync(['Pharmacy'])).results[0].created).toBe(0);
    expect(ok(await acct(finance).get('/integrations')).pending).toMatchObject({ emrBilling: 0, payrollAccrual: 0, payrollSettlement: 0, pharmacy: 0 });
  });

  it('posts store issues and write-offs at cost, but not receipts (the bill carries those)', async () => {
    const storekeeper = await member(A, ['INVENTORY_OFFICER']);
    const item = ok(await emr(storekeeper).post('/stores/items', { sku: 'GLV-01', name: 'Examination gloves (box)', category: 'PPE', unit: 'box', reorderLevel: 5 }), 201);
    const store = ok(await emr(storekeeper).get('/stores')).locations.find((l) => l.type === 'STORE');
    ok(await emr(storekeeper).post('/stores/receipts', { itemId: item.id, locationId: store.id, qty: 20, unitCostMinor: 450_000 }, key()), 201);
    ok(await emr(storekeeper).post('/stores/issues', { itemId: item.id, locationId: store.id, qty: 4, department: 'Theatre' }, key()), 201);
    ok(await emr(storekeeper).post('/stores/write-offs', { itemId: item.id, qty: 1, reason: 'Damaged in transit', locationId: store.id }, key()), 201);
    const valuation = ok(await acct(finance).get('/inventory'));
    expect(valuation.accounts[item.id]).toEqual({ inventory: 1210, cogs: 5010 });
    expect(valuation.batches.filter((b) => b.itemId === item.id).reduce((n, b) => n + b.qtyRemaining, 0)).toBe(15);
    const r = (await sync(['Stores'])).results[0];
    expect(r).toMatchObject({ module: 'Stores', created: 2, skipped: 1, errors: [] });
    expect((await sync(['Stores'])).results[0]).toMatchObject({ created: 0, skipped: 0 });
    const t = await tb();
    expect(bal(t, 5010)).toBe(18000); // 4 boxes × ₦4,500
    expect(bal(t, 5900)).toBe(4500);
    expect(bal(t, 1210)).toBe(-22500); // the receipt itself waits for its bill
    expect(t.inBalance).toBe(true);
  });

  it('records stock paid for outside a bill straight into the books, once', async () => {
    const item = (await acct(finance).get('/inventory')).body.data.items.find((i) => i.sku === 'GLV-01');
    expect((await acct(finance).post('/inventory/receipts', { itemId: item.id, qty: 10, unitCostMinor: 450_000, fundingAccount: 1100 })).status).toBe(409); // a control account
    const r = ok(await acct(finance).post('/inventory/receipts', { itemId: item.id, qty: 10, unitCostMinor: 450_000, fundingAccount: 1000, reference: 'Cash purchase' }), 201);
    expect(r.value).toBe(45000);
    expect((await sync(['Stores'])).results[0]).toMatchObject({ created: 0, skipped: 0 }); // already in the books
    const t = await tb();
    expect(bal(t, 1210)).toBe(-22500 + 45000);
    expect(t.inBalance).toBe(true);
  });
});
