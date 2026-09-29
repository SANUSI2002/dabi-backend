// Billing against real Postgres with RLS on, fed by real clinical flows (lab, pharmacy, wards).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient, prisma } from './fixtures.js';

const year = new Date().getUTCFullYear();
const DAY = 86_400_000;
const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    patch: (path, body, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let admin; let finance; let cashier; let supervisor; let doctor; let nurse; let pharmacist; let bFinance;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const PRICES = [
  ['CONSULTATION', 'OUTPATIENT', 'Outpatient consultation', 500_000],
  ['CONSULTATION', 'INPATIENT', 'Inpatient review', 1_000_000],
  ['LAB', 'FBC', 'Full blood count', 350_000],
  ['LAB', 'MP_RDT', 'Malaria RDT', 150_000],
  ['MEDICATION', 'AMLO5', 'Amlodipine 5 mg (tablet)', 5_000],
  ['BED_DAY', 'GENERAL', 'General ward bed-day', 800_000],
  ['BED_DAY', 'ICU', 'ICU bed-day', 1_500_000],
  ['BED_DAY', 'ICUA', 'ICU A bed-day', 2_000_000],
];

async function visit() {
  const patient = (await as(A).post('/patients', newPatient())).body.data;
  const encounter = (await as(doctor).post('/encounters', { patientId: patient.id })).body.data;
  await as(doctor).post(`/encounters/${encounter.id}/start`, {}, ifMatch(1));
  return { patient, encounter };
}
/** Orders FBC + MP RDT + LIPID and collects the specimen for FBC+LIPID only (MP left uncollected). */
async function labWork(encounter) {
  const collected = (await as(doctor).post(`/encounters/${encounter.id}/lab-orders`, { tests: ['FBC', 'LIPID'] })).body.data;
  await as(nurse).post(`/lab/orders/${collected.id}/collect`, {}, ifMatch(1));
  await as(doctor).post(`/encounters/${encounter.id}/lab-orders`, { tests: ['MP_RDT'] });
}
async function dispensed(encounter, quantity = 30) {
  await as(pharmacist).post('/pharmacy/stock/receipts', { formularyCode: 'AMLO5', batchNumber: `B-${randomUUID().slice(0, 6)}`, expiryDate: `${year + 2}-01-31`, quantity }, key());
  const rx = (await as(doctor).post(`/encounters/${encounter.id}/prescriptions`, { items: [{ drugCode: 'AMLO5', dose: 5, doseUnit: 'mg', frequency: 'OD', durationDays: quantity }] })).body.data;
  await as(pharmacist).post(`/pharmacy/prescriptions/${rx.id}/approve`, {}, ifMatch(1));
  return (await as(pharmacist).post(`/pharmacy/prescriptions/${rx.id}/dispense`, { lines: [{ itemId: rx.items[0].id, quantity }] }, key())).body.data;
}
const capture = (encounter, who = finance) => as(who).post(`/billing/encounters/${encounter.id}/capture`);
const charges = async (encounter) => (await as(finance).get(`/billing/encounters/${encounter.id}/charges`)).body.data.items;
const invoice = (encounter, body = {}, who = cashier, headers = {}) => as(who).post(`/billing/encounters/${encounter.id}/invoices`, body, headers);
const pay = (inv, amountMinor, who = cashier, headers = key(), extra = {}) => as(who).post(`/billing/invoices/${inv.id}/payments`, { amountMinor, method: 'CASH', ...extra }, headers);
const reconciled = async (who = finance) => (await as(who).get('/billing/reconciliation')).body.data;

beforeAll(async () => {
  A = await createTenant('billA');
  B = await createTenant('billB');
  admin = { ...A };
  finance = await member(A, ['FINANCE_OFFICER']);
  cashier = await member(A, ['RECEPTIONIST']);
  supervisor = await member(A, ['FINANCE_OFFICER', 'HOSPITAL_ADMIN']);
  doctor = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  pharmacist = await member(A, ['PHARMACIST']);
  bFinance = await member(B, ['FINANCE_OFFICER']);
  for (const [category, reference, name, unitPriceMinor] of PRICES) {
    expect((await as(finance).post('/billing/prices', { category, reference, name, unitPriceMinor })).status).toBe(201);
  }
  await as(finance).post('/billing/prices', { category: 'MEDICATION', reference: 'OMEP20', name: 'Omeprazole 20 mg (capsule)', unitPriceMinor: 12_345, taxRateBp: 750 });
});

describe('price list', () => {
  it('is managed by finance, unique per item, and read by cashiers', async () => {
    expect((await as(finance).post('/billing/prices', { category: 'LAB', reference: 'FBC', name: 'Again', unitPriceMinor: 1 })).body.error.code).toBe('PRICE_REFERENCE_IN_USE');
    expect((await as(doctor).post('/billing/prices', { category: 'LAB', reference: 'UA', name: 'Urinalysis', unitPriceMinor: 100_000 })).status).toBe(403);
    expect((await as(finance).post('/billing/prices', { category: 'LAB', reference: 'UA', name: 'Urinalysis', unitPriceMinor: 1000.5 })).status).toBe(400);
    const list = (await as(cashier).get('/billing/prices?category=LAB')).body.data.items;
    expect(list.map((p) => [p.reference, p.unitPriceMinor])).toEqual([['FBC', 350_000], ['MP_RDT', 150_000]]);
  });
});

describe('charge capture', () => {
  it('charges a visit once per source, skips uncollected tests, and reports what has no price', async () => {
    const { encounter } = await visit();
    await labWork(encounter);
    await dispensed(encounter, 30);
    const first = (await capture(encounter)).body.data;
    expect(first.created).toBe(3); // consultation, FBC, amlodipine
    expect(first.unpriced).toEqual([expect.objectContaining({ category: 'LAB', reference: 'LIPID' })]);
    expect((await capture(encounter)).body.data.created).toBe(0);

    const rows = await charges(encounter);
    expect(rows.map((c) => [c.category, c.description, c.quantity, c.amountMinor]).sort()).toEqual([
      ['CONSULTATION', 'Consultation (outpatient)', 1, 500_000],
      ['LAB', 'Full blood count', 1, 350_000],
      ['MEDICATION', 'Amlodipine 5 mg (tablet)', 30, 150_000],
    ].sort());
    expect(rows.every((c) => c.status === 'UNBILLED')).toBe(true);
  });

  it('credits returned medicine at the price charged, once per return', async () => {
    const { encounter } = await visit();
    const dispense = await dispensed(encounter, 30);
    await capture(encounter);
    await as(finance).patch(`/billing/prices/${(await prisma.emrPriceItem.findFirst({ where: { organizationId: A.organizationId, reference: 'AMLO5' } })).id}`, { unitPriceMinor: 9_000 }, ifMatch(1));
    const line = dispense.lines[0];
    await as(pharmacist).post(`/pharmacy/dispenses/${dispense.id}/returns`, { lines: [{ lineId: line.id, quantity: 10 }], reason: 'Unused', restock: true }, key());
    expect((await capture(encounter)).body.data.created).toBe(1);
    expect((await capture(encounter)).body.data.created).toBe(0);
    await as(pharmacist).post(`/pharmacy/dispenses/${dispense.id}/returns`, { lines: [{ lineId: line.id, quantity: 5 }], reason: 'Unused', restock: true }, key());
    await capture(encounter);
    const credits = (await charges(encounter)).filter((c) => c.sourceType === 'DISPENSE_RETURN');
    expect(credits.map((c) => [c.quantity, c.unitPriceMinor, c.amountMinor])).toEqual([[-10, 5_000, -50_000], [-5, 5_000, -25_000]]);
  });

  it('bills bed-days per night, at the ward-code price over the ward-kind price, and nothing for telemedicine consultations', async () => {
    const icu = (await as(admin).post('/wards', { code: 'ICUA', name: 'ICU A', kind: 'ICU', beds: ['A1'] })).body.data;
    const bed = (await as(admin).get(`/wards/${icu.id}/beds`)).body.data.beds[0];
    const { encounter } = await visit();
    const admission = (await as(doctor).post(`/encounters/${encounter.id}/admission`, { bedId: bed.id, reason: 'Sepsis' })).body.data;
    await prisma.emrAdmission.update({ where: { id: admission.id }, data: { admittedAt: new Date(Date.now() - 2 * DAY - 3_600_000) } });
    await as(doctor).post(`/admissions/${admission.id}/discharge`, { disposition: 'HOME', summary: 'Improved on antibiotics, discharged home.' }, ifMatch(1));
    await capture(encounter);
    await capture(encounter);
    const beds = (await charges(encounter)).filter((c) => c.category === 'BED_DAY');
    expect(beds).toHaveLength(2);
    expect(beds.every((c) => c.unitPriceMinor === 2_000_000 && c.description.startsWith('Bed-day, ICU A'))).toBe(true);
    expect((await charges(encounter)).find((c) => c.category === 'CONSULTATION').description).toBe('Consultation (inpatient)');

    const tele = await prisma.emrEncounter.create({ data: { organizationId: A.organizationId, patientId: (await as(A).post('/patients', newPatient())).body.data.id, class: 'TELEHEALTH', status: 'FINISHED', source: 'TELEMEDICINE', sourceReference: randomUUID(), createdByUserId: doctor.userId } });
    expect((await capture(tele)).body.data).toEqual({ created: 0, unpriced: [] });
  });
});

describe('invoices and payments', () => {
  it('issues numbered invoices from unbilled charges with exact tax, once', async () => {
    const { encounter } = await visit();
    const rx = (await as(doctor).post(`/encounters/${encounter.id}/prescriptions`, { items: [{ drugCode: 'OMEP20', dose: 20, doseUnit: 'mg', frequency: 'OD', durationDays: 3 }] })).body.data;
    await as(pharmacist).post('/pharmacy/stock/receipts', { formularyCode: 'OMEP20', batchNumber: 'OM-BILL', expiryDate: `${year + 2}-01-31`, quantity: 50 }, key());
    await as(pharmacist).post(`/pharmacy/prescriptions/${rx.id}/approve`, {}, ifMatch(1));
    await as(pharmacist).post(`/pharmacy/prescriptions/${rx.id}/dispense`, { lines: [{ itemId: rx.items[0].id, quantity: 3 }] }, key());

    expect((await invoice(encounter, { discountMinor: 10_000, discountReason: 'Staff' })).status).toBe(403);
    const issued = await invoice(encounter);
    expect(issued.status).toBe(201);
    const inv = issued.body.data;
    expect(inv.number).toMatch(new RegExp(`^INV-${year}-\\d{6}$`));
    // 3 × 12,345 = 37,035; tax 7.5% = 2,777.625 → 2,778 (rounded half away from zero, in the database too)
    expect(inv.charges.find((c) => c.category === 'MEDICATION')).toMatchObject({ amountMinor: 37_035, taxMinor: 2_778 });
    expect(inv).toMatchObject({ subtotalMinor: 537_035, taxMinor: 2_778, discountMinor: 0, totalMinor: 539_813, balanceMinor: 539_813, status: 'ISSUED' });
    expect((await invoice(encounter)).body.error.code).toBe('NOTHING_TO_INVOICE');
    const detail = (await as(cashier).get(`/billing/invoices/${inv.id}`)).body.data;
    expect(detail.ledger.map((l) => [l.kind, l.amountMinor, l.balanceAfterMinor])).toEqual([['INVOICE_ISSUED', 539_813, 539_813]]);
  });

  it('takes payments once per key, refuses overpayment, and settles the invoice', async () => {
    const { encounter } = await visit();
    const inv = (await invoice(encounter, { discountMinor: 50_000, discountReason: 'Hardship waiver' }, finance)).body.data;
    expect(inv.totalMinor).toBe(450_000);
    expect((await as(cashier).post(`/billing/invoices/${inv.id}/payments`, { amountMinor: 1_000, method: 'CASH' })).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await pay(inv, 1_000, cashier, key(), { method: 'BANK_TRANSFER' })).status).toBe(400); // no reference
    const over = await pay(inv, 450_001);
    expect(over.body.error).toMatchObject({ code: 'OVERPAYMENT', details: { balanceMinor: 450_000 } });

    const headers = key();
    const part = await pay(inv, 200_000, cashier, headers);
    expect(part.body.data).toMatchObject({ receiptNumber: expect.stringMatching(new RegExp(`^RCPT-${year}-\\d{6}$`)), invoice: { status: 'PARTIALLY_PAID', balanceMinor: 250_000 } });
    const replay = await pay(inv, 200_000, cashier, headers);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.receiptNumber).toBe(part.body.data.receiptNumber);
    const rest = await pay(inv, 250_000, cashier, key(), { method: 'POS', reference: 'POS-778812' });
    expect(rest.body.data.invoice).toMatchObject({ status: 'PAID', balanceMinor: 0 });
    expect((await pay(inv, 1)).status).toBe(409);
    expect(await prisma.emrPayment.count({ where: { invoiceId: inv.id } })).toBe(2);
  });

  it('reversals need a different, authorised person; unpaid invoices can be voided and re-issued', async () => {
    const { encounter } = await visit();
    const inv = (await invoice(encounter)).body.data;
    const payment = (await pay(inv, 500_000)).body.data;
    expect((await as(cashier).post(`/billing/payments/${payment.id}/reverse`, { reason: 'Bounced' })).status).toBe(403);
    expect((await as(supervisor).post(`/billing/invoices/${inv.id}/void`, { reason: 'Wrong patient' }, ifMatch(2))).status).toBe(409);
    const reversed = await as(supervisor).post(`/billing/payments/${payment.id}/reverse`, { reason: 'Transfer recalled by bank' });
    expect(reversed.body.data).toMatchObject({ status: 'REVERSED', reversedByUserId: supervisor.userId });
    expect((await as(supervisor).post(`/billing/payments/${payment.id}/reverse`, { reason: 'Again' })).status).toBe(409);

    const own = (await pay(inv, 100_000, supervisor)).body.data;
    const self = await as(supervisor).post(`/billing/payments/${own.id}/reverse`, { reason: 'Mistake' });
    expect(self.status).toBe(403);
    expect(self.body.error.message).toMatch(/someone other than/);
    await as(admin).post(`/billing/payments/${own.id}/reverse`, { reason: 'Keyed against the wrong invoice' });

    const current = (await as(cashier).get(`/billing/invoices/${inv.id}`)).body.data;
    expect(current.ledger.map((l) => l.kind)).toEqual(['INVOICE_ISSUED', 'PAYMENT', 'PAYMENT_REVERSED', 'PAYMENT', 'PAYMENT_REVERSED']);
    const voided = await as(supervisor).post(`/billing/invoices/${inv.id}/void`, { reason: 'Issued to the wrong patient' }, ifMatch(current.version));
    expect(voided.body.data).toMatchObject({ status: 'VOID', balanceMinor: 0 });
    expect((await charges(encounter)).every((c) => c.status === 'UNBILLED' && c.invoiceId === null)).toBe(true);
    const again = (await invoice(encounter)).body.data;
    expect(Number(again.number.slice(-6))).toBeGreaterThan(Number(inv.number.slice(-6)));
    expect((await reconciled()).balanced).toBe(true);
  });

  it('manual charges: from the price list or hand-priced; unbilled ones can be voided, and voided captures stay voided', async () => {
    const { encounter } = await visit();
    const bad = await as(finance).post(`/billing/encounters/${encounter.id}/charges`, { quantity: 1, category: 'PROCEDURE', unitPriceMinor: 1_000 });
    expect(bad.status).toBe(400);
    const dressing = await as(finance).post(`/billing/encounters/${encounter.id}/charges`, { quantity: 2, category: 'PROCEDURE', description: 'Wound dressing', unitPriceMinor: 250_000 });
    expect(dressing.body.data).toMatchObject({ sourceType: 'MANUAL', amountMinor: 500_000 });
    await capture(encounter);
    const consult = (await charges(encounter)).find((c) => c.category === 'CONSULTATION');
    expect((await as(finance).post(`/billing/charges/${consult.id}/void`, { reason: 'Follow-up visit is free' })).body.data.status).toBe('VOIDED');
    expect((await capture(encounter)).body.data.created).toBe(0);
    const inv = (await invoice(encounter)).body.data;
    expect(inv.totalMinor).toBe(500_000);
    expect((await as(finance).post(`/billing/charges/${dressing.body.data.id}/void`, { reason: 'Too late' })).status).toBe(409);
  });

  it('two cashiers invoicing one visit, or paying the last balance, at the same time: one succeeds', async () => {
    const { encounter } = await visit();
    const racing = await Promise.all([invoice(encounter), invoice(encounter, {}, finance)]);
    expect(racing.map((r) => r.status).sort()).toEqual([201, 409]);
    const inv = racing.find((r) => r.status === 201).body.data;
    const payments = await Promise.all([pay(inv, 500_000, cashier), pay(inv, 500_000, finance)]);
    expect(payments.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await as(cashier).get(`/billing/invoices/${inv.id}`)).body.data.amountPaidMinor).toBe(500_000);
  });
});

describe('statements, invariants and isolation', () => {
  it('a patient statement shows what is owed and what is still unbilled', async () => {
    const { patient, encounter } = await visit();
    const inv = (await invoice(encounter)).body.data;
    await pay(inv, 100_000);
    await labWork(encounter);
    await capture(encounter);
    const statement = (await as(cashier).get(`/billing/patients/${patient.id}/statement`)).body.data;
    expect(statement).toMatchObject({ outstandingMinor: 400_000, unbilledMinor: 350_000 });
    expect((await reconciled()).balanced).toBe(true);
  });

  it('the database refuses wrong arithmetic, edited money, ledger changes and overpaid invoices', async () => {
    const tenant = { organizationId: A.organizationId };
    const { patient, encounter } = await visit();
    const base = { organizationId: A.organizationId, patientId: patient.id, encounterId: encounter.id, category: 'OTHER', description: 'x', currency: 'NGN', sourceType: 'MANUAL', serviceAt: new Date(), createdByUserId: finance.userId };
    await expect(withTenant(tenant, (tx) => tx.emrCharge.create({ data: { ...base, quantity: 2, unitPriceMinor: 100n, amountMinor: 250n, taxMinor: 0n } }))).rejects.toThrow();
    await expect(withTenant(tenant, (tx) => tx.emrCharge.create({ data: { ...base, quantity: 1, unitPriceMinor: 1_000n, taxRateBp: 750, amountMinor: 1_000n, taxMinor: 70n } }))).rejects.toThrow();
    const charge = await withTenant(tenant, (tx) => tx.emrCharge.create({ data: { ...base, quantity: 1, unitPriceMinor: 1_000n, taxRateBp: 750, amountMinor: 1_000n, taxMinor: 75n } }));
    await expect(withTenant(tenant, (tx) => tx.emrCharge.updateMany({ where: { id: charge.id }, data: { unitPriceMinor: 1n } }))).rejects.toThrow();
    const inv = (await invoice(encounter)).body.data;
    await expect(withTenant(tenant, (tx) => tx.emrInvoice.updateMany({ where: { id: inv.id }, data: { totalMinor: 1n } }))).rejects.toThrow();
    await expect(withTenant(tenant, (tx) => tx.emrInvoice.updateMany({ where: { id: inv.id }, data: { amountPaidMinor: BigInt(inv.totalMinor) + 1n } }))).rejects.toThrow();
    await expect(prisma.emrBillingLedger.deleteMany({ where: { invoiceId: inv.id } })).rejects.toThrow();
  });

  it('another organization cannot see, invoice, pay or capture anything here', async () => {
    const { patient, encounter } = await visit();
    const inv = (await invoice(encounter)).body.data;
    expect((await as(bFinance).get(`/billing/invoices/${inv.id}`)).status).toBe(404);
    expect((await pay(inv, 1_000, bFinance)).status).toBe(404);
    expect((await as(bFinance).post(`/billing/encounters/${encounter.id}/capture`)).status).toBe(404);
    expect((await as(bFinance).post(`/billing/encounters/${encounter.id}/invoices`, {})).status).toBe(404);
    expect((await as(bFinance).get(`/billing/patients/${patient.id}/statement`)).status).toBe(404);
    expect((await as(bFinance).get('/billing/prices')).body.data.items).toHaveLength(0);
    expect((await reconciled(bFinance)).invoicesChecked).toBe(0);
  });
});
