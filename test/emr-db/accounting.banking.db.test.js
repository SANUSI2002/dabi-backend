// Banking and expense claims against real Postgres with RLS on: transfers and bank-only transactions,
// imported statements booked by hand or by rule, a reconciliation that completes only when it ties out,
// live feeds refused (no provider), and expense claims approved by role, booked and reimbursed — with
// the trial balance tying out throughout.
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
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };
const today = () => new Date().toISOString();

let A; let B; let finance; let finance2; let admin; let controller; let nurse;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const banking = async (who = finance) => ok(await as(who).get('/banking'));
const tb = async () => ok(await as(finance).get('/ledger/trial-balance'));
const bal = (t, n) => { const r = t.rows.find((x) => x.number === n); return r ? r.debit - r.credit : 0; };

beforeAll(async () => {
  A = await createTenant('bankA', { modules: ['accounting'] });
  B = await createTenant('bankB', { modules: ['accounting'] });
  finance = await member(A, ['FINANCE_OFFICER']);
  finance2 = await member(A, ['FINANCE_OFFICER']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  controller = await member(A, ['FINANCE_CONTROLLER']);
  nurse = await prisma.wfEmployee.create({ data: { organizationId: A.organizationId, name: 'Amaka Obi', role: 'Nurse', hireDate: new Date('2024-01-01') } });
  await banking(); // opens the books
});

describe('banking', () => {
  it('lists the ledger bank accounts and records bank details, a new bank only by the controller', async () => {
    expect((await banking()).accounts.map((a) => a.accountNumber)).toEqual(expect.arrayContaining([1000, 1010]));
    ok(await as(finance).post('/banking/accounts', { number: 1010, name: 'Main bank', bankName: 'GTBank', accountName: 'Sabi Test — Current', accountNo: '••••4471', subtype: 'bank' }), 201);
    expect((await as(finance).post('/banking/accounts', { number: 1030, name: 'Payroll account', bankName: 'Access', accountName: 'Payroll', accountNo: '••••1100', subtype: 'bank' })).status).toBe(403);
    ok(await as(controller).post('/banking/accounts', { number: 1030, name: 'Payroll account', bankName: 'Access', accountName: 'Payroll', accountNo: '••••1100', subtype: 'bank', openingBalance: 500000 }), 201);
    const data = await banking();
    expect(data.accounts.find((a) => a.accountNumber === 1010)).toMatchObject({ bankName: 'GTBank', accountNo: '••••4471' });
    expect(bal(await tb(), 1030)).toBe(500000);
    expect((await banking(await member(B, ['FINANCE_OFFICER']))).accounts.some((a) => a.bankName === 'GTBank')).toBe(false); // tenant B sees none of it
  });

  it('records transfers and bank transactions, never against a control account', async () => {
    ok(await as(finance).post('/banking/transfers', { fromAccount: 1030, toAccount: 1010, amount: 200000, date: today() }), 201);
    expect((await as(finance).post('/banking/transactions', { accountNumber: 1010, contraAccount: 1100, direction: 'in', amount: 1000, date: today(), description: 'Patient deposit' })).status).toBe(409); // receivables is a control account
    expect((await as(finance).post('/banking/transfers', { fromAccount: 1010, toAccount: 5600, amount: 10, date: today() })).status).toBe(400);
    const t = await tb();
    expect(bal(t, 1010)).toBe(200000);
    expect(bal(t, 1030)).toBe(300000);
  });

  it('imports a statement, books lines by hand and by rule', async () => {
    ok(await as(finance).post('/banking/statement-lines/import', { accountNumber: 1010, lines: [
      { date: today(), description: 'COMMISSION ON TURNOVER & VAT', amount: -3120 },
      { date: today(), description: 'POS SETTLEMENT — INTERSWITCH', amount: 184500, reference: 'ISW/1' },
      { date: today(), description: 'TRF FRM WALK-IN — USSD', amount: 45000 },
    ] }), 201);
    ok(await as(finance).post('/banking/rules', { accountNumber: 1010, name: 'Bank charges', descriptionContains: 'commission', direction: 'out', contraAccount: 5600, memo: 'Bank charges (auto)' }), 201);
    expect(ok(await as(finance).post('/banking/accounts/1010/apply-rules'))).toEqual({ matched: 1 });
    const pos = (await banking()).statementLines.find((l) => l.reference === 'ISW/1');
    ok(await as(finance).post(`/banking/statement-lines/${pos.id}/book`, { contraAccount: 4000 }));
    expect((await as(finance).post(`/banking/statement-lines/${pos.id}/book`, { contraAccount: 4000 })).status).toBe(409); // once only
    const data = await banking();
    expect(data.statementLines.filter((l) => !l.reconciled).map((l) => l.amount)).toEqual([45000]);
    expect(data.statementLines.find((l) => l.amount === -3120)).toMatchObject({ reconciled: true, ruleApplied: expect.any(String) });
    const t = await tb();
    expect(bal(t, 1010)).toBe(200000 - 3120 + 184500);
    expect(bal(t, 5600)).toBe(3120);
    expect(t.inBalance).toBe(true);
  });

  it('completes a reconciliation only when the cleared balance meets the statement', async () => {
    const recon = ok(await as(finance).post('/banking/reconciliations', { accountNumber: 1010, statementDate: today(), closingBalance: 381380 }), 201);
    expect((await as(finance).post('/banking/reconciliations', { accountNumber: 1010, statementDate: today(), closingBalance: 1 })).body.error.code).toBe('RECONCILIATION_IN_PROGRESS');
    const ledger = ok(await as(finance).get('/ledger'));
    const keys = ledger.entries.filter((e) => e.status === 'Posted').flatMap((e) => e.lines.filter((l) => l.accountNumber === 1010).map((l) => `${e.id}:${l.id}`));
    expect(keys).toHaveLength(3);
    expect((await as(finance).post(`/banking/reconciliations/${recon.id}/toggle`, { movementKey: `${ledger.entries[0].id}:nope` })).status).toBe(400);
    for (const k of keys.slice(0, 2)) ok(await as(finance).post(`/banking/reconciliations/${recon.id}/toggle`, { movementKey: k }));
    expect((await as(finance).post(`/banking/reconciliations/${recon.id}/complete`)).body.error.message).toMatch(/out/);
    ok(await as(finance).post(`/banking/reconciliations/${recon.id}/toggle`, { movementKey: keys[2] }));
    ok(await as(finance).post(`/banking/reconciliations/${recon.id}/complete`));
    expect((await banking()).reconciliations[0]).toMatchObject({ status: 'Reconciled', openingBalance: 0, reconciledLineIds: expect.arrayContaining(keys) });
  });

  it('refuses live bank feeds rather than simulating one', async () => {
    const res = await as(finance).post('/banking/connections', { accountNumber: 1010, provider: 'Mono' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('BANK_FEED_NOT_CONFIGURED');
    expect((await banking()).connections).toEqual([]);
  });
});

describe('expense claims', () => {
  const line = (amount, extra = {}) => ({ accountNumber: 5230, description: 'Fuel — sample runs', amount, ...extra });
  const claims = async () => ok(await as(finance).get('/expenses')).claims;

  it('books a small petty-cash claim at once, against an expense account only', async () => {
    expect((await as(finance).post('/expenses', { date: today(), title: 'Wrong', payMode: 'Petty Cash', lines: [{ ...line(100), accountNumber: 1010 }] })).status).toBe(404);
    const c = ok(await as(finance).post('/expenses', { claimantId: nurse.id, date: today(), title: 'Dispatch fuel', payMode: 'Petty Cash', lines: [line(15000)] }), 201);
    expect(ok(await as(finance).post(`/expenses/${c.id}/submit`)).status).toBe('Paid');
    expect((await claims()).find((x) => x.id === c.id)).toMatchObject({ claimantId: nurse.id, status: 'Paid', journalEntryId: expect.any(String) });
    const t = await tb();
    expect(bal(t, 5230)).toBe(15000);
    expect(bal(t, 1000)).toBe(-15000);
  });

  it('routes a large reimbursable claim by role, never to its submitter, then reimburses it', async () => {
    // starter rules: ₦50k–₦250k expense claims need an Approver
    const c = ok(await as(finance).post('/expenses', { claimantId: nurse.id, date: today(), title: 'Conference travel', payMode: 'Reimburse to staff', lines: [line(150000)] }), 201);
    expect(ok(await as(finance).post(`/expenses/${c.id}/submit`)).status).toBe('Pending Approval');
    expect((await claims()).find((x) => x.id === c.id).approval).toMatchObject({ submittedByMe: true, decidableByMe: false });
    expect((await as(finance).post(`/expenses/${c.id}/decide`, { decision: 'Approved' })).body.error.code).toBe('OWN_REQUEST');
    expect((await as(finance2).post(`/expenses/${c.id}/decide`, { decision: 'Approved' })).status).toBe(403);
    expect(ok(await as(admin).post(`/expenses/${c.id}/decide`, { decision: 'Approved' })).status).toBe('Approved');
    expect(bal(await tb(), 2110)).toBe(-150000);
    ok(await as(finance).post(`/expenses/${c.id}/pay`, { fromAccount: 1030 }));
    expect((await as(finance).post(`/expenses/${c.id}/pay`, { fromAccount: 1030 })).status).toBe(409);
    const t = await tb();
    expect(bal(t, 2110)).toBe(0);
    expect(t.inBalance).toBe(true);
  });

  it('refuses a claim reimbursed to staff when there is nobody on record to reimburse', async () => {
    // finance has no HR record in this hospital, and names no claimant
    const res = await as(finance).post('/expenses', { date: today(), title: 'Taxi', payMode: 'Reimburse to staff', lines: [line(2000)] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/staff record/);
    ok(await as(finance).post('/expenses', { date: today(), title: 'Taxi', payMode: 'Petty Cash', lines: [line(2000)] }), 201);
  });

  it('discards drafts, which then disappear', async () => {
    const c = ok(await as(finance).post('/expenses', { date: today(), title: 'Draft', payMode: 'Petty Cash', lines: [line(500)] }), 201);
    ok(await as(finance).post(`/expenses/${c.id}/discard`));
    expect((await claims()).some((x) => x.id === c.id)).toBe(false);
  });
});
