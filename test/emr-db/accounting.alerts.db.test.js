// Accounting alerts by email, against real Postgres with RLS on: only staff who opted in get a digest,
// it holds only the alerts on for them (approvals only those they may decide), an alert is emailed once
// (again only if still outstanding a week later), digests are paced, and a failed send is retried.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant, prisma } from './fixtures.js';
import { sendAlertDigests } from '../../src/modules/accounting/email/staffAlerts.js';

const as = (who) => {
  const url = (path) => `/api/v1/accounting/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}) => request(app).post(url(path)).set('Authorization', who.auth).send(body),
    put: (path, body = {}) => request(app).put(url(path)).set('Authorization', who.auth).send(body),
  };
};
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const prefs = (extra) => ({ approvalPending: true, invoiceOverdue: true, billDueSoon: true, lowStock: true, budgetExceeded: true, largeJournal: false, ...extra });
const HOUR = 3_600_000;

let A; let finance; let controller; let customer; let controllerEmail; let financeEmail; let saved;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const overdueInvoice = async (description, amount) => {
  const inv = ok(await as(finance).post('/receivables/invoices', { customerId: customer.id, date: daysAgo(45), lines: [{ accountNumber: 4000, description, qty: 1, unitPrice: amount, taxRateId: 'tax-vat-exempt' }] }), 201);
  ok(await as(finance).post(`/receivables/invoices/${inv.id}/issue`));
  return (await prisma.acctSalesDoc.findUnique({ where: { id: inv.id } })).number;
};
// the digests for this organization's people only (other test files share the database)
const run = async (now, send) => {
  const outbox = [];
  await sendAlertDigests({ now, configured: () => true, send: async (job) => { outbox.push(job); return send ? send(job) : { ok: true, providerId: 'synthetic' }; } });
  return outbox.filter((j) => [controllerEmail, financeEmail].includes(j.recipient));
};

beforeAll(async () => {
  saved = { from: process.env.PASSWORD_RESET_EMAIL_FROM };
  process.env.PASSWORD_RESET_EMAIL_FROM = 'Sabi Health <billing@sabi.test>';
  A = await createTenant('alertsA', { modules: ['accounting'] });
  finance = await member(A, ['FINANCE_OFFICER']);
  controller = await member(A, ['FINANCE_CONTROLLER']);
  controllerEmail = (await prisma.user.findUnique({ where: { id: controller.userId } })).email;
  financeEmail = (await prisma.user.findUnique({ where: { id: finance.userId } })).email;
  customer = ok(await as(finance).post('/receivables/customers', { name: 'Leadway HMO', type: 'HMO', email: 'claims@leadway.test' }), 201);
});
afterAll(() => {
  if (saved.from === undefined) delete process.env.PASSWORD_RESET_EMAIL_FROM; else process.env.PASSWORD_RESET_EMAIL_FROM = saved.from;
});

describe('accounting alerts by email', () => {
  it('emails only those who opted in, and each alert once', async () => {
    const first = await overdueInvoice('Retainer — August', 40000);
    expect(await run(new Date())).toEqual([]); // nobody has opted in
    ok(await as(controller).put('/notification-prefs', prefs({ emailDigest: true })));
    ok(await as(finance).put('/notification-prefs', prefs({ emailDigest: false })));
    expect(ok(await as(controller).get('/projects')).notificationPrefs).toMatchObject({ emailDigest: true });

    const now = new Date();
    const sent = await run(now);
    expect(sent).toHaveLength(1);
    expect(sent[0].recipient).toBe(controllerEmail);
    expect(sent[0].body).toContain('Overdue invoices (1)');
    expect(sent[0].body).toContain(`${first} — Leadway HMO, NGN 40,000.00`);

    expect(await run(new Date(now.getTime() + HOUR))).toEqual([]); // paced: one digest per six hours
    expect(await run(new Date(now.getTime() + 7 * HOUR))).toEqual([]); // nothing new
    const second = await overdueInvoice('Retainer — September', 25000);
    const later = await run(new Date(now.getTime() + 8 * HOUR));
    expect(later).toHaveLength(1);
    expect(later[0].body).toContain(second);
    expect(later[0].body).not.toContain(first); // already told
    // still outstanding a week on: a reminder
    const week = await run(new Date(now.getTime() + 8 * 24 * HOUR));
    expect(week[0].body).toContain(first);
  });

  it('includes approvals only for those who may decide them, and retries a failed send', async () => {
    const vendor = ok(await as(finance).post('/payables/vendors', { name: 'Fidson Healthcare', category: 'Pharmaceuticals' }), 201);
    // ₦1.5m bill: the starter rules want an Accountant — the controller may decide any step
    const bill = ok(await as(finance).post('/payables/bills', { vendorId: vendor.id, date: daysAgo(1), lines: [{ accountNumber: 1200, description: 'Antibiotics', qty: 100, unitPrice: 15000, taxRateId: 'tax-vat-exempt' }] }), 201);
    ok(await as(finance).post(`/payables/bills/${bill.id}/submit`));
    const number = (await prisma.acctPurchaseDoc.findUnique({ where: { id: bill.id } })).number;
    const now = new Date(Date.now() + 30 * 24 * HOUR);
    const failed = await run(now, async () => ({ ok: false, retryable: true }));
    expect(failed[0].body).toContain(`Bill ${number}`);
    const retried = await run(new Date(now.getTime() + 15 * 60_000));
    expect(retried).toHaveLength(1); // the slot was given back
    expect(retried[0].body).toContain('Waiting for your approval (1)');
    // the submitter opts in too: their own submission is never theirs to approve
    ok(await as(finance).put('/notification-prefs', prefs({ emailDigest: true, invoiceOverdue: false })));
    const theirs = (await run(new Date(now.getTime() + 20 * 60_000))).filter((j) => j.recipient !== controllerEmail);
    expect(theirs.every((j) => !j.body.includes(number))).toBe(true);
  });
});
