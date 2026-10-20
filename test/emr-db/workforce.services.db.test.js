// HR services against real Postgres with RLS on: the company asset register with requests, one holder
// at a time and returns; helpdesk tickets numbered per organization and worked by their assignees; and
// disciplinary queries raised by the line manager, countersigned through the query workflow.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant } from './fixtures.js';

const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const as = (who) => {
  const url = (path) => `/api/v1/workforce/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}) => request(app).post(url(path)).set('Authorization', who.auth).send(body),
    patch: (path, body = {}, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };

let A; let hr; let hr2; let doctor; let nurse; let desk; let ids;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const services = async (who = hr) => (await as(who).get('/services')).body.data;

beforeAll(async () => {
  A = await createTenant('wsA', { modules: ['workforce'] });
  hr = await member(A, ['HR_OFFICER']);
  hr2 = await member(A, ['HR_OFFICER']);
  doctor = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  desk = await member(A, ['RECEPTIONIST']);
  await as(hr).post('/people/employees/import-members');
  const emps = (await as(hr).get('/people')).body.data.employees;
  const idOf = (who) => emps.find((e) => e.userId === who.userId).id;
  ids = { hr: idOf(hr), doctor: idOf(doctor), nurse: idOf(nurse), desk: idOf(desk) };
  const nurseEmp = emps.find((e) => e.id === ids.nurse);
  await as(hr).patch(`/people/employees/${ids.nurse}`, { reportingManagerId: ids.doctor }, ifMatch(nurseEmp.version));
});

describe('HR services', () => {
  it('keeps the asset register, one holder at a time', async () => {
    const cat = ok(await as(hr).post('/services/asset-categories', { name: 'Laptops', description: 'Staff laptops' }), 201);
    expect((await as(hr).post('/services/asset-categories', { name: 'laptops' })).status).toBe(409);
    const laptop = ok(await as(hr).post('/services/assets', { name: 'ThinkPad T14', categoryId: cat.id, trackingId: 'LT-001', purchaseDate: '2026-01-10', purchaseCost: 950000 }), 201);
    expect((await as(nurse).post('/services/asset-requests', { employeeId: ids.desk, categoryId: cat.id, description: 'for desk' })).status).toBe(403);
    const req = ok(await as(nurse).post('/services/asset-requests', { employeeId: ids.nurse, categoryId: cat.id, description: 'Charting on rounds' }), 201);
    expect((await services(nurse)).assets).toEqual([]); // not the register
    expect((await as(hr).post('/services/allocations', { assetId: laptop.id, employeeId: ids.nurse, requestId: req.id })).status).toBe(409); // approve first
    ok(await as(hr).post(`/services/asset-requests/${req.id}/decide`, { status: 'Approved' }));
    ok(await as(hr).post('/services/allocations', { assetId: laptop.id, employeeId: ids.nurse, requestId: req.id }), 201);
    expect((await as(hr).post('/services/allocations', { assetId: laptop.id, employeeId: ids.desk })).status).toBe(409); // in use
    let mine = await services(nurse);
    expect(mine.assets.map((a) => a.trackingId)).toEqual(['LT-001']);
    expect(mine.requests[0].status).toBe('Allocated');
    ok(await as(hr).post(`/services/allocations/${mine.allocations[0].id}/return`, { condition: 'Damaged', note: 'Cracked screen' }));
    const data = await services();
    expect(data.assets[0].status).toBe('Not Available');
    expect(data.allocations[0]).toMatchObject({ returnCondition: 'Damaged', returnNote: 'Cracked screen' });
    expect((await as(hr).post('/services/allocations', { assetId: laptop.id, employeeId: ids.desk })).status).toBe(409);
  });

  it('numbers tickets per organization and lets their assignees work them', async () => {
    const first = ok(await as(nurse).post('/services/tickets', { type: 'IT Support', title: 'EMR login fails', description: 'Reset link expired', assigningType: 'Department', raisedOn: 'Records & HMIS', priority: 3 }), 201);
    const second = ok(await as(desk).post('/services/tickets', { type: 'Facilities', title: 'Fridge alarm', description: 'EPI fridge alarm', assigningType: 'Individual', raisedOn: ids.doctor, priority: 3 }), 201);
    expect(second.seq).toBe(first.seq + 1);
    expect((await services(nurse)).tickets.map((t) => t.title)).toEqual(['EMR login fails']);
    expect((await services(doctor)).tickets.map((t) => t.title)).toEqual(['Fridge alarm']); // sent to him
    expect((await as(nurse).post(`/services/tickets/${first.id}/status`, { status: 'Resolved' })).status).toBe(403);
    expect((await as(nurse).post(`/services/tickets/${first.id}/assign`, { staffIds: [ids.desk] })).status).toBe(403);
    ok(await as(hr).post(`/services/tickets/${first.id}/assign`, { staffIds: [ids.desk] }));
    ok(await as(desk).post(`/services/tickets/${first.id}/status`, { status: 'Resolved' }));
    expect((await services()).tickets.find((t) => t.id === first.id)).toMatchObject({ status: 'Resolved', assignedTo: [ids.desk], resolvedAt: expect.any(String) });
    const data = await services(nurse);
    expect(data.faqCategories.map((c) => c.name).sort()).toEqual(['HR & Payroll', 'IT & Systems']);
    ok(await as(hr).post('/services/faqs', { categoryId: data.faqCategories[0].id, question: 'How do I reset my password?', answer: 'Use Forgot password on the sign-in page.' }), 201);
    expect((await services(nurse)).faqs).toHaveLength(1);
  });

  it('countersigns a line manager\'s query before HR records it as sent', async () => {
    expect((await as(desk).post('/services/queries', { employeeId: ids.nurse, subject: 'Lateness', body: 'x', responseDeadlineDays: 3 })).status).toBe(403); // not her manager
    expect((await as(nurse).post('/services/queries', { employeeId: ids.nurse, subject: 'x', body: 'x', responseDeadlineDays: 3 })).body.error.code).toBe('OWN_REQUEST');
    const q = ok(await as(doctor).post('/services/queries', { employeeId: ids.nurse, subject: 'Repeated lateness', body: 'You were late on three occasions this month.', responseDeadlineDays: 3 }), 201);
    expect((await as(hr).post(`/services/queries/${q.id}/sent`)).status).toBe(409); // not signed
    // starter query workflow: line manager confirms (he raised it — so HR takes that step), then HR countersigns
    const inst = (await as(hr).get('/workflows')).body.data.instances.find((i) => i.reference === q.id);
    expect(inst.active[0].approverLabel).toMatch(/routed to HR/);
    const decide = async (who) => {
      const step = (await as(who).get('/workflows')).body.data.inbox.find((x) => x.instanceId === inst.id);
      ok(await as(who).post(`/workflows/instances/${inst.id}/decide`, { nodeId: step.nodeId, decision: 'approve' }));
    };
    await decide(hr); // the line-manager step, routed to HR
    await decide(hr2); // HR countersignature
    expect((await as(hr).get('/workflows')).body.data.instances.find((i) => i.id === inst.id).status).toBe('Approved');
    ok(await as(hr).post(`/services/queries/${q.id}/sent`));
    expect((await services(doctor)).queries[0]).toMatchObject({ status: 'Sent', raisedBy: ids.doctor, employeeId: ids.nurse });
    expect((await services(nurse)).queries).toEqual([]);
  });
});
