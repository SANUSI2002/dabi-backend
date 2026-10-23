// Projects and notification preferences against real Postgres with RLS on: billable projects tied to a
// customer, time logged by staff and billed into an invoice exactly once (voiding frees it), and each
// user's own alert preferences.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant, prisma } from './fixtures.js';

const as = (who) => {
  const url = (path) => `/api/v1/accounting/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}) => request(app).post(url(path)).set('Authorization', who.auth).send(body),
    put: (path, body = {}) => request(app).put(url(path)).set('Authorization', who.auth).send(body),
  };
};
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };
const today = () => new Date().toISOString();

let A; let finance; let finance2; let doctor; let customer; let project;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const projects = async (who = finance) => ok(await as(who).get('/projects'));

beforeAll(async () => {
  A = await createTenant('prjA', { modules: ['accounting'] });
  finance = await member(A, ['FINANCE_OFFICER']);
  finance2 = await member(A, ['FINANCE_OFFICER']);
  doctor = await prisma.wfEmployee.create({ data: { organizationId: A.organizationId, name: 'Dr Tunde Bello', role: 'Doctor', hireDate: new Date('2023-01-01') } });
  customer = ok(await as(finance).post('/receivables/customers', { name: 'Shell Clinic Contract', type: 'Corporate' }), 201);
});

describe('projects', () => {
  it('creates a billable project for a customer, with a unique code', async () => {
    project = ok(await as(finance).post('/projects', { code: 'occ-01', name: 'Occupational health screening', customerId: customer.id, startDate: today(), billable: true, budgetAmount: 500000 }), 201);
    expect((await as(finance).post('/projects', { code: 'OCC-01', name: 'Again', startDate: today(), billable: false })).status).toBe(409);
    expect((await projects()).projects[0]).toMatchObject({ code: 'OCC-01', customerId: customer.id, billable: true, budgetAmount: 500000 });
  });

  it('logs staff time to revenue accounts only', async () => {
    expect((await as(finance).post('/projects/time', { projectId: project.id, staffId: doctor.id, date: today(), hours: 3, description: 'Screening', billable: true, rate: 20000, revenueAccount: 5100 })).status).toBe(400);
    ok(await as(finance).post('/projects/time', { projectId: project.id, staffId: doctor.id, date: today(), hours: 3, description: 'Screening clinic', billable: true, rate: 20000, revenueAccount: 4000 }), 201);
    ok(await as(finance).post('/projects/time', { projectId: project.id, staffId: doctor.id, date: today(), hours: 1, description: 'Admin', billable: false, revenueAccount: 4000 }), 201);
    expect((await projects()).timeEntries.map((t) => t.status).sort()).toEqual(['Non-billable', 'Unbilled']);
  });

  it('bills unbilled time into an invoice once, and voiding frees it again', async () => {
    const unbilled = (await projects()).timeEntries.filter((t) => t.status === 'Unbilled').map((t) => t.id);
    const inv = ok(await as(finance).post('/receivables/invoices', { customerId: customer.id, date: today(), lines: [], projectId: project.id, timeEntryIds: unbilled }), 201);
    const invoice = ok(await as(finance).get('/receivables')).invoices.find((i) => i.id === inv.id);
    expect(invoice.lines).toEqual([expect.objectContaining({ accountNumber: 4000, qty: 3, unitPrice: 20000, description: 'Screening clinic (3h)' })]);
    expect((await projects()).timeEntries.find((t) => t.id === unbilled[0])).toMatchObject({ status: 'Invoiced', invoiceId: inv.id });
    expect((await as(finance).post('/receivables/invoices', { customerId: customer.id, date: today(), lines: [], timeEntryIds: unbilled })).status).toBe(409);
    expect((await as(finance).post(`/projects/time/${unbilled[0]}/remove`)).status).toBe(409); // billed time stays
    ok(await as(finance).post(`/receivables/void/invoice/${inv.id}`));
    expect((await projects()).timeEntries.find((t) => t.id === unbilled[0])).toMatchObject({ status: 'Unbilled' });
  });

  it("keeps each user's notification preferences to themselves", async () => {
    expect((await projects()).notificationPrefs).toBeNull();
    const prefs = { approvalPending: true, invoiceOverdue: false, billDueSoon: true, lowStock: false, budgetExceeded: true, largeJournal: true };
    ok(await as(finance).put('/notification-prefs', prefs));
    expect((await projects()).notificationPrefs).toEqual(prefs);
    expect((await projects(finance2)).notificationPrefs).toBeNull();
  });
});
