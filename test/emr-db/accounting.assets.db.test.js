// Fixed assets, budgets and tax returns against real Postgres with RLS on: an asset bought outright,
// monthly depreciation once per month (with catch-up), revaluation then impairment, construction in
// progress capitalised, disposal at a gain; budgets with one active per year; a VAT return prepared from
// the ledger, its filing recorded with the authority's acknowledgement, and remitted. The trial balance
// ties out throughout.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant } from './fixtures.js';

const as = (who) => {
  const url = (path) => `/api/v1/accounting/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}) => request(app).post(url(path)).set('Authorization', who.auth).send(body),
    patch: (path, body = {}, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };
const ym = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const monthsBack = (k) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 15, 12)); };

let A; let finance; let admin;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const assets = async () => ok(await as(finance).get('/fixed-assets'));
const plan = async () => ok(await as(finance).get('/planning'));
const tb = async () => ok(await as(finance).get('/ledger/trial-balance'));
const bal = (t, n) => { const r = t.rows.find((x) => x.number === n); return r ? r.debit - r.credit : 0; };

beforeAll(async () => {
  A = await createTenant('faA', { modules: ['accounting'] });
  finance = await member(A, ['FINANCE_OFFICER']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  await assets(); // opens the books
});

describe('fixed assets', () => {
  let scanner;
  it('registers an asset bought outright onto a fixed-asset account only', async () => {
    expect((await as(finance).post('/fixed-assets', { name: 'Wrong', category: 'X', acquisitionDate: monthsBack(3).toISOString(), cost: 100, assetAccountNumber: 5600, method: 'Straight Line', usefulLifeMonths: 12, salvageValue: 0 })).status).toBe(400);
    scanner = ok(await as(finance).post('/fixed-assets', {
      name: 'Ultrasound scanner', category: 'Medical Equipment', acquisitionDate: monthsBack(3).toISOString(), cost: 1_200_000, assetAccountNumber: 1510, method: 'Straight Line', usefulLifeMonths: 60, salvageValue: 0, fundedFromAccount: 1010,
    }), 201);
    expect(scanner.tag).toBe('FA-0001');
    const t = await tb();
    expect(bal(t, 1510)).toBe(1_200_000);
    expect(bal(t, 1010)).toBe(-1_200_000);
  });

  it('runs depreciation once a month, and catches up the months still owed', async () => {
    const period = ym(monthsBack(3));
    expect(ok(await as(finance).post('/fixed-assets/depreciation/run', { period }), 201)).toEqual({ period, total: 20000 });
    expect((await as(finance).post('/fixed-assets/depreciation/run', { period })).status).toBe(409);
    const caught = ok(await as(finance).post('/fixed-assets/depreciation/catch-up', {}));
    expect(caught).toEqual({ ran: [ym(monthsBack(2)), ym(monthsBack(1)), ym(monthsBack(0))], total: 60000 });
    const data = await assets();
    expect(data.assets[0]).toMatchObject({ accumulatedDepreciation: 80000, lastDepreciatedPeriod: ym(new Date()) });
    expect(data.runs).toHaveLength(4);
    const t = await tb();
    expect(bal(t, 5500)).toBe(80000);
    expect(bal(t, 1590)).toBe(-80000);
  });

  it('revalues up to the reserve, then impairs through the reserve into a loss', async () => {
    // carrying 1,120,000 → 1,300,000 (+180,000 reserve) → 1,000,000 (−180,000 reserve, −120,000 impairment)
    ok(await as(finance).post(`/fixed-assets/${scanner.id}/revalue`, { newCarryingValue: 1_300_000, date: new Date().toISOString() }));
    ok(await as(finance).post(`/fixed-assets/${scanner.id}/revalue`, { newCarryingValue: 1_000_000, date: new Date().toISOString(), note: 'Market check' }));
    const data = await assets();
    expect(data.assets[0]).toMatchObject({ status: 'Impaired', revaluationReserve: 0, impairmentLoss: 120000 });
    expect(data.revaluations.map((r) => r.kind)).toEqual(expect.arrayContaining(['Revaluation', 'Impairment']));
    const t = await tb();
    expect(bal(t, 3300)).toBe(0);
    expect(bal(t, 5520)).toBe(120000);
    expect(t.inBalance).toBe(true);
  });

  it('capitalises construction in progress under its own register number', async () => {
    const w = ok(await as(finance).post('/fixed-assets/construction', { name: 'Theatre extension', category: 'Buildings', assetAccountNumber: 1500, startDate: new Date().toISOString() }), 201);
    expect(w.tag).toBe('CWIP-0001');
    expect((await as(finance).post(`/fixed-assets/${w.id}/capitalise`, { date: new Date().toISOString(), method: 'Straight Line', usefulLifeMonths: 240, salvageValue: 0 })).status).toBe(409); // no costs yet
    ok(await as(finance).post(`/fixed-assets/${w.id}/construction-costs`, { amount: 500000, date: new Date().toISOString(), description: 'Blockwork', fromAccount: 1010 }));
    expect(bal(await tb(), 1580)).toBe(500000);
    ok(await as(finance).post(`/fixed-assets/${w.id}/capitalise`, { date: new Date().toISOString(), method: 'Straight Line', usefulLifeMonths: 240, salvageValue: 0 }));
    const built = (await assets()).assets.find((a) => a.id === w.id);
    expect(built).toMatchObject({ status: 'Active', cost: 500000, tag: 'FA-0002' });
    const t = await tb();
    expect(bal(t, 1580)).toBe(0);
    expect(bal(t, 1500)).toBe(500000);
  });

  it('disposes at a gain, and retires only what is carried at nothing', async () => {
    const built = (await assets()).assets.find((a) => a.tag === 'FA-0002');
    expect((await as(finance).post(`/fixed-assets/${built.id}/retire`)).body.error.message).toMatch(/Dispose of it instead/);
    ok(await as(finance).post(`/fixed-assets/${built.id}/dispose`, { date: new Date().toISOString(), proceeds: 650000, proceedsAccount: 1010 }));
    expect((await as(finance).post(`/fixed-assets/${built.id}/dispose`, { date: new Date().toISOString(), proceeds: 1, proceedsAccount: 1010 })).status).toBe(409);
    const t = await tb();
    expect(bal(t, 1500)).toBe(0);
    expect(bal(t, 4100)).toBe(-150000);
    expect(t.inBalance).toBe(true);
  });
});

describe('budgets and tax returns', () => {
  it('keeps one active budget a year, edited only as a draft, activated with approval rights', async () => {
    const cc = ok(await as(finance).post('/planning/cost-centres', { code: 'lab', name: 'Laboratory' }), 201);
    expect((await as(finance).post('/planning/cost-centres', { code: 'LAB', name: 'Again' })).status).toBe(409);
    const year = new Date().getUTCFullYear();
    const b1 = ok(await as(finance).post('/planning/budgets', { name: 'FY budget', fiscalYear: year }), 201);
    ok(await as(finance).post(`/planning/budgets/${b1.id}/lines`, { accountNumber: 5500, costCentreId: cc.id, monthly: Array(12).fill(25000) }));
    expect((await as(finance).post(`/planning/budgets/${b1.id}/status`, { status: 'Active' })).status).toBe(403);
    ok(await as(admin).post(`/planning/budgets/${b1.id}/status`, { status: 'Active' }));
    expect((await as(finance).post(`/planning/budgets/${b1.id}/lines`, { accountNumber: 5600, monthly: Array(12).fill(1) })).status).toBe(409);
    const b2 = ok(await as(finance).post('/planning/budgets', { name: 'Revised', fiscalYear: year, copyFromId: b1.id, adjustPct: 10 }), 201);
    ok(await as(admin).post(`/planning/budgets/${b2.id}/status`, { status: 'Active' }));
    const data = await plan();
    expect(data.budgets.find((b) => b.id === b1.id).status).toBe('Closed');
    expect(data.budgets.find((b) => b.id === b2.id)).toMatchObject({ status: 'Active', lines: [expect.objectContaining({ accountNumber: 5500, monthly: Array(12).fill(27500) })] });
  });

  it('prepares a VAT return from the ledger, records the filing, and remits it', async () => {
    // output VAT on a cash sale of 100,000 at 7.5%
    ok(await as(finance).post('/receivables/sales-receipts', { customerName: 'Walk-in', method: 'Cash', date: new Date().toISOString(), lines: [{ accountNumber: 4020, description: 'Retail', qty: 1, unitPrice: 100000, taxRateId: 'tax-vat-standard' }], depositAccountNumber: 1010 }), 201);
    const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
    const r = ok(await as(finance).post('/planning/tax-returns', { returnType: 'VAT', periodStart: start, periodEnd: new Date().toISOString() }), 201);
    expect(r.netPayable).toBe(7500);
    expect((await as(finance).post('/planning/tax-returns', { returnType: 'VAT', periodStart: start, periodEnd: new Date().toISOString() })).status).toBe(409);
    ok(await as(finance).post(`/planning/tax-returns/${r.id}/filing`, { submissionRef: 'FIRS-ACK-00123' }));
    ok(await as(finance).post(`/planning/tax-returns/${r.id}/pay`, { fromAccount: 1010 }));
    expect((await plan()).taxReturns[0]).toMatchObject({ status: 'Paid', submissionRef: 'FIRS-ACK-00123', filedVia: 'FIRS e-filing portal', filedBy: expect.any(String) });
    const t = await tb();
    expect(bal(t, 2200)).toBe(0);
    expect(t.inBalance).toBe(true);
  });

  it('keeps forecast scenarios for the organization: income and expense lines, set months, removed ones gone', async () => {
    const lines = [{ accountNumber: 4000, baseAmount: 2_500_000, monthlyGrowthPct: 2 }, { accountNumber: 5230, baseAmount: 400_000, monthlyGrowthPct: 0, overrides: [null, 650_000] }];
    expect((await as(finance).post('/planning/forecasts', { name: 'Bad', basis: 'Manual base', startPeriod: '2026-11', months: 6, lines: [{ accountNumber: 1010, baseAmount: 1, monthlyGrowthPct: 0 }] })).body.error.message).toMatch(/income and expense/);
    const { id } = ok(await as(finance).post('/planning/forecasts', { name: 'FY27 base case', basis: 'Manual base', startPeriod: '2026-11', months: 6, lines }), 201);
    let f = ok(await as(finance).get('/planning')).forecasts.find((x) => x.id === id);
    expect(f).toMatchObject({ name: 'FY27 base case', months: 6, version: 1 });
    expect(f.lines[1].overrides).toEqual([null, 650000, null, null, null, null]);
    ok(await as(finance).patch(`/planning/forecasts/${id}`, { name: 'FY27 stretch', lines: f.lines.map((l) => ({ ...l, monthlyGrowthPct: 5 })) }, ifMatch(1)));
    expect((await as(finance).patch(`/planning/forecasts/${id}`, { name: 'stale' }, ifMatch(1))).status).toBe(412);
    f = ok(await as(finance).get('/planning')).forecasts.find((x) => x.id === id);
    expect(f).toMatchObject({ name: 'FY27 stretch', version: 2 });
    expect(f.lines.every((l) => l.monthlyGrowthPct === 5)).toBe(true);
    ok(await as(finance).post(`/planning/forecasts/${id}/remove`));
    expect(ok(await as(finance).get('/planning')).forecasts.find((x) => x.id === id)).toBeUndefined();
  });
});
