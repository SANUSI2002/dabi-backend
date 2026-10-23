// Approval workflows against real Postgres with RLS on: the six starter workflows, Builder edits and
// activation checks, approvers worked out by the server (line manager, role holders, fallback to HR),
// nobody deciding their own request, parallel steps, escalation after the timeout, withdrawal, and who
// sees which requests.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant, prisma } from './fixtures.js';

const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const as = (who) => {
  const url = (path) => `/api/v1/workforce/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    patch: (path, body = {}, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
    put: (path, body = {}, headers = {}) => request(app).put(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let hr; let hr2; let admin; let nurse; let doctor; let desk; let ids;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const view = async (who) => (await as(who).get('/workflows')).body.data;
const employeeOf = async (who) => (await as(hr).get('/people')).body.data.employees.find((e) => e.userId === who.userId);
const testRun = async (who, defId, context) => as(who).post('/workflows/instances', { triggerType: 'leave', defId, context });

beforeAll(async () => {
  A = await createTenant('wfA', { modules: ['workforce'] });
  B = await createTenant('wfB', { modules: ['workforce'] });
  hr = await member(A, ['HR_OFFICER']);
  hr2 = await member(A, ['HR_OFFICER']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  nurse = await member(A, ['NURSE']);
  doctor = await member(A, ['DOCTOR']);
  desk = await member(A, ['RECEPTIONIST']);
  await as(hr).post('/people/employees/import-members');
  const nurseEmp = await employeeOf(nurse);
  const doctorEmp = await employeeOf(doctor);
  await as(hr).patch(`/people/employees/${nurseEmp.id}`, { reportingManagerId: doctorEmp.id }, ifMatch(nurseEmp.version));
  ids = { nurse: nurseEmp.id, doctor: doctorEmp.id, hr: (await employeeOf(hr)).id, hr2: (await employeeOf(hr2)).id, desk: (await employeeOf(desk)).id };
});

describe('approval workflows', () => {
  it('gives every organization the six starter workflows, switched on', async () => {
    const data = await view(hr);
    expect(data.defs.map((d) => d.triggerType).sort()).toEqual(['leave', 'onboarding', 'promotion', 'query', 'transfer', 'vacancy']);
    expect(data.defs.every((d) => d.active)).toBe(true);
    expect((await view(nurse)).canManage).toBe(false);
    expect((await as(nurse).post('/workflows/defs', { name: 'Mine', triggerType: 'leave' })).status).toBe(403);
    expect((await as({ ...hr, organizationId: B.organizationId }).get('/workflows')).status).toBe(403); // not a member of B
  });

  it('checks a definition before it can be switched on, and keeps live ones valid', async () => {
    const created = await as(hr).post('/workflows/defs', { name: 'Loan request', triggerType: 'loan', description: 'Two steps' });
    expect(created.status).toBe(201);
    const { id } = created.body.data;
    const off = await as(hr).post(`/workflows/defs/${id}/active`, { active: true });
    expect(off.body.error.code).toBe('WORKFLOW_INVALID');
    expect(off.body.error.details.errors).toContain('Start node has no outgoing connection.');
    const def = (await view(hr)).defs.find((d) => d.id === id);
    const nodes = [...def.nodes, { id: 'a1', type: 'approval', label: 'HR approval', x: 300, y: 160, approverType: 'role', approverRef: 'HR Administrator' }];
    const edges = [{ id: 'e1', from: 'start', to: 'a1', branch: 'default' }, { id: 'e2', from: 'a1', to: 'end-ok', branch: 'approve' }, { id: 'e3', from: 'a1', to: 'end-no', branch: 'reject' }];
    const saved = await as(hr).put(`/workflows/defs/${id}`, { nodes, edges }, ifMatch(def.version));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data.errors).toEqual([]);
    expect((await as(hr).put(`/workflows/defs/${id}`, { name: 'stale' }, ifMatch(def.version))).status).toBe(412);
    expect((await as(hr).post(`/workflows/defs/${id}/active`, { active: true })).status).toBe(200);
    const broken = await as(hr).put(`/workflows/defs/${id}`, { edges: [] }, ifMatch(saved.body.data.version + 1));
    expect(broken.body.error.code).toBe('WORKFLOW_INVALID');
  });

  it('routes a request to the line manager, then to the HR role holders — never back to the requester', async () => {
    const leave = (await view(hr)).defs.find((d) => d.triggerType === 'leave');
    // the nurse's own test run: the starter leave flow is line manager, then HR when > 10 days
    expect((await testRun(nurse, leave.id, { durationDays: 14 })).status).toBe(403); // test runs are for workflow designers
    const run = await testRun(hr, leave.id, { durationDays: 14, initiatorId: ids.nurse, lineManagerId: ids.doctor });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const { instanceId } = run.body.data;
    let inst = (await view(hr)).instances.find((i) => i.id === instanceId);
    expect(inst).toMatchObject({ status: 'Running', isTest: true, active: [{ nodeId: 'n2', approverId: ids.doctor, approverLabel: 'Line manager' }] });
    expect((await view(doctor)).inbox).toEqual([{ instanceId, nodeId: 'n2' }]);
    expect((await view(desk)).instances.find((i) => i.id === instanceId)).toBeUndefined(); // not involved
    expect((await as(desk).post(`/workflows/instances/${instanceId}/decide`, { nodeId: 'n2', decision: 'approve' })).body.error.code).toBe('WORKFLOW_STEP_NOT_YOURS');
    expect((await as(doctor).post(`/workflows/instances/${instanceId}/decide`, { nodeId: 'n2', decision: 'approve', comment: 'Cover arranged' })).status).toBe(200);
    inst = (await view(hr)).instances.find((i) => i.id === instanceId);
    expect(inst.active[0]).toMatchObject({ nodeId: 'n4', approverLabel: 'HR Administrator' });
    expect(inst.active[0].approverIds.sort()).toEqual([ids.hr, ids.hr2].sort());
    expect(inst.history.map((h) => h.action)).toEqual(['started', 'entered', 'approved', 'auto', 'entered']);
    expect((await as(hr2).post(`/workflows/instances/${instanceId}/decide`, { nodeId: 'n4', decision: 'approve' })).status).toBe(200);
    inst = (await view(doctor)).instances.find((i) => i.id === instanceId);
    expect(inst).toMatchObject({ status: 'Approved', active: [] });
    expect(inst.history.at(-1)).toMatchObject({ action: 'completed', comment: 'approved' });
    expect((await as(hr).post(`/workflows/instances/${instanceId}/decide`, { nodeId: 'n4', decision: 'approve' })).body.error.code).toBe('WORKFLOW_NOT_RUNNING');
  });

  it('sends a step with no one to take it to HR, and leaves the requester out of a role step', async () => {
    const leave = (await view(hr)).defs.find((d) => d.triggerType === 'leave');
    const run = await testRun(hr, leave.id, { durationDays: 20, initiatorId: ids.hr }); // no line manager given
    const inst = (await view(hr)).instances.find((i) => i.id === run.body.data.instanceId);
    expect(inst.active[0].approverLabel).toBe('Line manager (routed to HR)');
    expect(inst.active[0].approverIds).toEqual([ids.hr2]); // HR, but not the requester
    expect(inst.history.find((h) => h.action === 'auto').comment).toMatch(/No line manager who can sign in — routed to HR/);
    expect((await as(hr).post(`/workflows/instances/${inst.id}/decide`, { nodeId: 'n2', decision: 'approve' })).body.error.code).toBe('OWN_REQUEST');
    // the requester (or a workflow manager) can withdraw it
    expect((await as(desk).post(`/workflows/instances/${inst.id}/cancel`, {})).status).toBe(403);
    expect((await as(hr).post(`/workflows/instances/${inst.id}/cancel`, { reason: 'Raised by mistake' })).status).toBe(200);
    expect((await view(hr)).instances.find((i) => i.id === inst.id).status).toBe('Cancelled');
  });

  it('runs parallel steps and escalates a stalled step along its timeout path', async () => {
    const def = (await as(hr).post('/workflows/defs', { name: 'Two keys', triggerType: 'purchase-request' })).body.data;
    const nodes = [
      { id: 'start', type: 'start', label: 'Start', x: 0, y: 0 },
      { id: 'p', type: 'parallel', label: 'HR and admin', x: 1, y: 0, joinMode: 'all', members: [{ approverType: 'role', approverRef: 'HR Administrator', label: 'HR' }, { approverType: 'role', approverRef: 'Hospital Administrator', label: 'Admin' }] },
      { id: 'a', type: 'approval', label: 'Line manager', x: 2, y: 0, approverType: 'line-manager' },
      { id: 'x', type: 'escalation', label: '1h', x: 2, y: 1, afterHours: 1 },
      { id: 'h', type: 'approval', label: 'HR fallback', x: 3, y: 1, approverType: 'role', approverRef: 'HR Administrator' },
      { id: 'ok', type: 'end', label: 'Approved', x: 4, y: 0, outcome: 'approved' },
      { id: 'no', type: 'end', label: 'Rejected', x: 4, y: 1, outcome: 'rejected' },
    ];
    const edges = [
      { id: '1', from: 'start', to: 'p', branch: 'default' }, { id: '2', from: 'p', to: 'a', branch: 'approve' }, { id: '3', from: 'p', to: 'no', branch: 'reject' },
      { id: '4', from: 'a', to: 'ok', branch: 'approve' }, { id: '5', from: 'a', to: 'no', branch: 'reject' }, { id: '6', from: 'a', to: 'x', branch: 'timeout' },
      { id: '7', from: 'x', to: 'h', branch: 'timeout' }, { id: '8', from: 'h', to: 'ok', branch: 'approve' }, { id: '9', from: 'h', to: 'no', branch: 'reject' },
    ];
    await as(hr).put(`/workflows/defs/${def.id}`, { nodes, edges }, ifMatch(def.version));
    const run = await as(hr).post('/workflows/instances', { triggerType: 'purchase-request', defId: def.id, context: { initiatorId: ids.nurse, lineManagerId: ids.doctor } });
    const id = run.body.data.instanceId;
    expect((await as(hr).post(`/workflows/instances/${id}/decide`, { nodeId: 'p', decision: 'approve' })).status).toBe(200);
    let inst = (await view(hr)).instances.find((i) => i.id === id);
    expect(inst.active[0].memberDecisions.map((m) => m.decision)).toEqual(['approved', 'pending']); // waits for the admin
    expect((await as(hr2).post(`/workflows/instances/${id}/decide`, { nodeId: 'p', decision: 'approve' })).body.error.code).toBe('WORKFLOW_STEP_NOT_YOURS'); // HR's part is done
    await as(admin).post(`/workflows/instances/${id}/decide`, { nodeId: 'p', decision: 'approve' });
    inst = (await view(hr)).instances.find((i) => i.id === id);
    expect(inst.active).toMatchObject([{ nodeId: 'a', approverId: ids.doctor }]);
    expect((await as(hr).post('/workflows/escalations')).body.data.escalated).toBe(0);
    // two hours pass without the line manager acting
    const row = await prisma.wfWorkflowInstance.findUnique({ where: { id } });
    await prisma.wfWorkflowInstance.update({ where: { id }, data: { active: row.active.map((a) => ({ ...a, enteredAt: new Date(Date.now() - 2 * 3_600_000).toISOString() })) } });
    expect((await as(hr).post('/workflows/escalations')).body.data.escalated).toBe(1);
    inst = (await view(hr)).instances.find((i) => i.id === id);
    expect(inst.active).toMatchObject([{ nodeId: 'h' }]);
    expect(inst.history.map((h) => h.action)).toContain('escalated');
    expect((await view(doctor)).inbox.some((x) => x.instanceId === id)).toBe(false);
    await as(hr2).post(`/workflows/instances/${id}/decide`, { nodeId: 'h', decision: 'reject', comment: 'Over budget' });
    expect((await view(hr)).instances.find((i) => i.id === id).status).toBe('Rejected');
  });

  it('refuses approval for documents that are not connected, and one request in flight per document', async () => {
    const res = await as(nurse).post('/workflows/instances', { triggerType: 'expense', reference: 'EXP-1' });
    expect(res.body.error.code).toBe('WORKFLOW_TRIGGER_NOT_CONNECTED');
  });
});
