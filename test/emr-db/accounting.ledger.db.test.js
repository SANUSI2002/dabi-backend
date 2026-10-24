// The general ledger against real Postgres with RLS on: starter books, balanced posting (refused by the
// service and by the database itself), control accounts kept out of manual entries, locks, reversal,
// drafts, opening balances, recurring journals, year-end close, permissions and tenant isolation.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant, prisma } from './fixtures.js';

const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const as = (who) => {
  const url = (path) => `/api/v1/accounting/organizations/${who.organizationId}/ledger${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    patch: (path, body = {}, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
    put: (path, body = {}, headers = {}) => request(app).put(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };
const tb = async (who, q = '') => ok(await as(who).get(`/trial-balance${q}`));
const row = (t, n) => t.rows.find((x) => x.number === n) ?? { debit: 0, credit: 0 };
const pay = (debitAcct, creditAcct, amount, extra = {}) => ({ date: '2026-03-10', memo: 'Test', lines: [{ accountNumber: debitAcct, debit: amount }, { accountNumber: creditAcct, credit: amount }], ...extra });

let A; let B; let finance; let controller; let nurse; let admin; let other;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });

beforeAll(async () => {
  A = await createTenant('alA', { modules: ['accounting'] });
  B = await createTenant('alB', { modules: ['emr'] }); // no accounting product
  finance = await member(A, ['FINANCE_OFFICER']);
  controller = await member(A, ['FINANCE_CONTROLLER']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  nurse = await member(A, ['NURSE']);
  other = await member(B, ['HOSPITAL_ADMIN']);
});

describe('general ledger', () => {
  it('starts the books with the starter chart, a head office and this year', async () => {
    const data = ok(await as(finance).get(''));
    expect(data.accounts).toHaveLength(67);
    // healthcare receivables: the allowance (a control account), capitation, denials and recoveries
    expect(data.accounts.find((a) => a.number === 1190)).toMatchObject({ subtype: 'contra_asset', allowManualEntry: false });
    expect(data.accounts.filter((a) => [4060, 4120, 4910].includes(a.number))).toHaveLength(3);
    expect(data.accounts.find((a) => a.number === 1100)).toMatchObject({ subtype: 'accounts_receivable', allowManualEntry: false });
    expect(data.branches).toEqual([expect.objectContaining({ code: 'HO', isHeadOffice: true })]);
    expect(data.periods.filter((p) => p.fiscalYear === new Date().getUTCFullYear())).toHaveLength(12);
    expect(data.entries).toEqual([]);
    expect(data.approvalRules.length).toBeGreaterThan(0);
    expect((await as(nurse).get('')).status).toBe(403);
    expect((await as(other).get('')).body.error.code).toBe('ACCOUNTING_ACCESS_DENIED');
  });

  it('posts only balanced entries, and keeps control accounts to their subledger', async () => {
    expect((await as(admin).post('/entries', pay(5200, 1010, 400000))).status).toBe(403); // admin approves, does not post
    const e = ok(await as(finance).post('/entries', pay(5200, 1010, 400000, { memo: 'March rent' })), 201);
    expect(e.number).toMatch(/^JE-2026-\d{6}$/);
    const bad = await as(finance).post('/entries', { date: '2026-03-10', memo: 'x', lines: [{ accountNumber: 5200, debit: 100 }, { accountNumber: 1010, credit: 90 }] });
    expect(bad.body.error).toMatchObject({ code: 'JOURNAL_UNBALANCED', message: expect.stringMatching(/Out of balance by 10.00/) });
    expect((await as(finance).post('/entries', pay(1100, 4000, 5000))).body.error.message).toMatch(/posted only by its subledger/);
    const t = await tb(finance);
    expect(row(t, 5200).debit).toBe(400000);
    expect(row(t, 1010).credit).toBe(400000);
    expect(t.inBalance).toBe(true);
  });

  it('refuses, in the database itself, an unbalanced posted entry or a change to posted lines', async () => {
    const branch = await prisma.acctBranch.findFirst({ where: { organizationId: A.organizationId } });
    await expect(prisma.$transaction(async (tx) => {
      const e = await tx.acctJournalEntry.create({ data: { organizationId: A.organizationId, number: 'JE-X-1', entryDate: new Date(), branchId: branch.id, source: 'Manual', memo: 'x', status: 'Draft', createdByUserId: 'u' } });
      await tx.acctJournalLine.createMany({ data: [{ organizationId: A.organizationId, entryId: e.id, lineNo: 1, accountNumber: 5200, debit: 100 }, { organizationId: A.organizationId, entryId: e.id, lineNo: 2, accountNumber: 1010, credit: 99 }] });
      await tx.acctJournalEntry.update({ where: { id: e.id }, data: { status: 'Posted', postedByUserId: 'u', postedAt: new Date() } });
    })).rejects.toThrow(/not balanced/);
    const posted = await prisma.acctJournalEntry.findFirst({ where: { organizationId: A.organizationId, status: 'Posted' } });
    await expect(prisma.acctJournalLine.updateMany({ where: { entryId: posted.id }, data: { debit: 1 } })).rejects.toThrow(/cannot change/);
  });

  it('respects locked periods and the books lock', async () => {
    const data = ok(await as(finance).get(''));
    const march = data.periods.find((p) => p.fiscalYear === 2026 && p.month === 3) ?? null;
    expect((await as(finance).post(`/periods/${march.id}/status`, { status: 'Locked' })).status).toBe(403);
    ok(await as(controller).post(`/periods/${march.id}/status`, { status: 'Locked' }));
    expect((await as(finance).post('/entries', pay(5200, 1010, 100))).body.error).toMatchObject({ code: 'BOOKS_LOCKED', message: expect.stringMatching(/Mar 2026 is locked/) });
    ok(await as(controller).post(`/periods/${march.id}/status`, { status: 'Open' }));
    ok(await as(controller).put('/lock', { booksLockedBefore: '2026-02-01' }, ifMatch(data.settingsVersion)));
    expect((await as(finance).post('/entries', pay(5200, 1010, 100, { date: '2026-01-15' }))).body.error.code).toBe('BOOKS_LOCKED');
    expect((await as(controller).put('/lock', { booksLockedBefore: null }, ifMatch(data.settingsVersion))).status).toBe(412);
  });

  it('reverses a posted entry once, netting it to nothing', async () => {
    const e = ok(await as(finance).post('/entries', pay(5300, 1000, 25000, { memo: 'Stationery' })), 201);
    expect((await as(finance).post(`/entries/${e.id}/reverse`)).status).toBe(403); // the controller reverses
    const rev = ok(await as(controller).post(`/entries/${e.id}/reverse`, { date: '2026-03-12' }), 201);
    expect((await as(controller).post(`/entries/${e.id}/reverse`)).status).toBe(409);
    const data = ok(await as(finance).get(''));
    expect(data.entries.find((x) => x.id === e.id)).toMatchObject({ status: 'Reversed', reversedByEntryId: rev.id });
    expect(data.entries.find((x) => x.id === rev.id)).toMatchObject({ source: 'Reversal', reversesEntryId: e.id, status: 'Posted' });
    const t = await tb(finance);
    expect(row(t, 5300)).toEqual({ debit: 0, credit: 0 });
  });

  it('keeps drafts editable until posted, and voids drafts', async () => {
    const d = ok(await as(finance).post('/entries', pay(5210, 1010, 9000, { status: 'Draft' })), 201);
    expect(row(await tb(finance), 5210).debit).toBe(0); // drafts do not count
    ok(await as(finance).patch(`/entries/${d.id}`, { lines: [{ accountNumber: 5210, debit: 12000 }, { accountNumber: 1010, credit: 12000 }] }, ifMatch(1)));
    ok(await as(finance).post(`/entries/${d.id}/post`, {}, ifMatch(2)));
    expect(row(await tb(finance), 5210).debit).toBe(12000);
    expect((await as(finance).post(`/entries/${d.id}/void`, {}, ifMatch(3))).status).toBe(409);
    const d2 = ok(await as(finance).post('/entries', pay(5210, 1010, 1, { status: 'Draft' })), 201);
    ok(await as(finance).post(`/entries/${d2.id}/void`, {}, ifMatch(1)));
  });

  it('books opening balances as journal entries against Opening Balance Equity', async () => {
    expect((await as(finance).post('/accounts', { number: 1030, name: 'Bank — Savings', type: 'asset', subtype: 'bank' })).status).toBe(403);
    ok(await as(controller).post('/accounts', { number: 1030, name: 'Bank — Savings', type: 'asset', subtype: 'bank', openingBalance: 2000000 }), 201);
    expect((await as(controller).post('/accounts', { number: 1030, name: 'dup', type: 'asset', subtype: 'bank' })).body.error.code).toBe('ACCOUNT_IN_USE');
    const t = await tb(finance);
    expect(row(t, 1030).debit).toBe(2000000);
    expect(row(t, 3900).credit).toBe(2000000);
    const tmpl = ok(await as(controller).post('/accounts/template', { templateId: 'tmpl-hospital-ng' }));
    expect(tmpl.added + tmpl.skipped).toBeGreaterThan(0);
    const imported = ok(await as(controller).post('/accounts/import', { rows: [{ number: 5950, name: 'Donations', type: 'expense', subtype: 'other_expense' }, { number: 1030, name: 'dup', type: 'asset', subtype: 'bank' }] }));
    expect(imported).toMatchObject({ added: 1, errors: [expect.stringMatching(/^Row 3: Account 1030 already exists/)] });
    const acct = ok(await as(finance).get('')).accounts.find((a) => a.number === 5950);
    ok(await as(controller).patch('/accounts/5950', { isActive: false }, ifMatch(acct.version)));
    expect((await as(finance).post('/entries', pay(5950, 1010, 10))).body.error.message).toMatch(/archived/);
  });

  it('runs recurring journals once per due month', async () => {
    const rj = ok(await as(finance).post('/recurring', { memo: 'Generator lease', lines: [{ accountNumber: 5220, debit: 50000 }, { accountNumber: 2100, credit: 50000 }], everyMonths: 1, startDate: '2026-04-01', endDate: '2026-06-30' }), 201);
    expect(ok(await as(finance).post('/recurring/run', { asOf: '2026-05-15' }))).toMatchObject({ posted: 2 });
    expect(ok(await as(finance).post('/recurring/run', { asOf: '2026-05-15' }))).toMatchObject({ posted: 0 });
    expect(ok(await as(finance).post('/recurring/run', { asOf: '2026-12-31' }))).toMatchObject({ posted: 1 });
    const r = ok(await as(finance).get('')).recurringJournals.find((x) => x.id === rj.id);
    expect(r).toMatchObject({ postedCount: 3, active: false });
    expect(row(await tb(finance), 5220).debit).toBe(150000);
  });

  it('closes the year to retained earnings and locks it', async () => {
    const preview = ok(await as(finance).get('/year-end/2026'));
    expect(preview.canClose).toBe(true);
    const expected = -(400000 + 12000 + 150000); // expenses only so far
    expect(preview.netIncome).toBe(expected);
    expect((await as(finance).post('/year-end/2026/close')).status).toBe(403);
    ok(await as(controller).post('/year-end/2026/close'));
    expect((await as(controller).post('/year-end/2026/close')).status).toBe(409);
    const t = await tb(finance, '?asOf=2026-12-31T23:59:59.000Z');
    expect(row(t, 5200)).toEqual({ debit: 0, credit: 0 });
    expect(row(t, 3200).debit).toBe(-expected);
    expect(t.inBalance).toBe(true);
    expect((await as(finance).post('/entries', pay(5200, 1010, 1, { date: '2026-11-01' }))).body.error.code).toBe('BOOKS_LOCKED');
    const data = ok(await as(finance).get(''));
    expect(data.fiscalYears.map((y) => `${y.year}:${y.status}`)).toEqual(expect.arrayContaining(['2026:Closed', '2027:Open']));
    expect(data.yearEndClosings[0]).toMatchObject({ year: 2026, netIncome: expected });
  });
});
