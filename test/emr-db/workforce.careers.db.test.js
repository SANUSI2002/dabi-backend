// Careers against real Postgres with RLS on: objectives with key-result progress, 360° feedback where
// each side writes only its own review, 1-on-1s, and promotions / branch transfers approved through
// their workflows (the employee's line manager and HR) before they change the employee record.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant } from './fixtures.js';

const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const as = (who) => {
  const url = (path) => `/api/v1/workforce/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    patch: (path, body = {}, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };

let A; let hr; let hr2; let doctor; let nurse; let desk; let ids; let position; let branch;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const careers = async (who) => (await as(who).get('/careers')).body.data;
const people = async () => (await as(hr).get('/people')).body.data;
const decideAll = async (who, reference, decision) => {
  const data = (await as(who).get('/workflows')).body.data;
  const inst = data.instances.find((i) => i.reference === reference && i.status === 'Running');
  const steps = data.inbox.filter((x) => x.instanceId === inst?.id);
  for (const step of steps) ok(await as(who).post(`/workflows/instances/${inst.id}/decide`, { nodeId: step.nodeId, decision }));
  return steps.length;
};

beforeAll(async () => {
  A = await createTenant('wcA', { modules: ['workforce'] });
  hr = await member(A, ['HR_OFFICER']);
  hr2 = await member(A, ['HR_OFFICER']);
  doctor = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  desk = await member(A, ['RECEPTIONIST']);
  await as(hr).post('/people/employees/import-members');
  const emps = (await people()).employees;
  const idOf = (who) => emps.find((e) => e.userId === who.userId).id;
  ids = { hr: idOf(hr), hr2: idOf(hr2), doctor: idOf(doctor), nurse: idOf(nurse), desk: idOf(desk) };
  const nurseEmp = emps.find((e) => e.id === ids.nurse);
  const dept = ok(await as(hr).post('/people/departments', { name: 'Nursing', code: 'NUR', hodId: ids.doctor }), 201);
  await as(hr).patch(`/people/employees/${ids.nurse}`, { reportingManagerId: ids.doctor, departmentId: dept.id }, ifMatch(nurseEmp.version));
  position = ok(await as(hr).post('/people/job-positions', { name: 'Senior Nurse', departmentId: dept.id }), 201);
  branch = ok(await as(hr).post('/people/companies', { name: 'Ikorodu Annex', code: 'IKD' }), 201);
});

describe('careers', () => {
  it('assigns objectives and lets the employee and their manager track progress', async () => {
    const { keyResults } = await careers(hr);
    expect(keyResults).toHaveLength(3);
    const kr = keyResults.find((k) => k.type === 'Numeric');
    expect((await as(nurse).post('/careers/objectives', { title: 'x', managerIds: [], assigneeIds: [ids.nurse], keyResultIds: [kr.id], durationUnit: 'Months', duration: 3 })).status).toBe(403);
    const o = ok(await as(hr).post('/careers/objectives', { title: 'Postpartum FP uptake', description: 'Counsel PNC clients', managerIds: [ids.doctor], assigneeIds: [ids.nurse, ids.desk], keyResultIds: [kr.id], durationUnit: 'Months', duration: 3 }), 201);
    const mine = (await careers(nurse)).employeeObjectives;
    expect(mine).toHaveLength(1); // only her own row
    const eo = mine[0];
    expect(eo).toMatchObject({ objectiveId: o.id, employeeId: ids.nurse, status: 'Not Started', progressPercentage: 0 });
    expect(ok(await as(nurse).post(`/careers/employee-objectives/${eo.id}/progress`, { keyResultId: eo.keyResults[0].id, currentValue: 20 }))).toMatchObject({ progressPercentage: 50, status: 'On Track' });
    expect((await as(nurse).post(`/careers/employee-objectives/${eo.id}/status`, { status: 'Closed' })).status).toBe(403); // managers set status
    ok(await as(doctor).post(`/careers/employee-objectives/${eo.id}/status`, { status: 'At Risk' }));
    expect((await careers(doctor)).employeeObjectives).toHaveLength(2); // the manager sees both rows
    const deskRow = (await careers(desk)).employeeObjectives[0];
    expect((await as(nurse).post(`/careers/employee-objectives/${deskRow.id}/progress`, { keyResultId: deskRow.keyResults[0].id, currentValue: 5 })).status).toBe(403);
  });

  it('runs a 360° review where each side writes only its own part', async () => {
    const answers = [{ question: 'Communicates effectively', rating: 4, comment: 'Clear handovers' }];
    expect((await as(nurse).post('/careers/feedback', { reviewCycle: 'Q4 2026', employeeId: ids.desk, managerId: ids.doctor })).status).toBe(403); // not the manager or HR
    const f = ok(await as(doctor).post('/careers/feedback', { reviewCycle: 'Q4 2026', employeeId: ids.nurse, managerId: ids.doctor }), 201);
    expect((await as(hr).post(`/careers/feedback/${f.id}/answers`, { role: 'self', answers })).status).toBe(403);
    expect((await as(nurse).post(`/careers/feedback/${f.id}/answers`, { role: 'manager', answers })).status).toBe(403);
    expect(ok(await as(nurse).post(`/careers/feedback/${f.id}/answers`, { role: 'self', answers }))).toMatchObject({ status: 'In Progress' });
    expect((await as(nurse).post(`/careers/feedback/${f.id}/answers`, { role: 'self', answers })).status).toBe(409);
    expect(ok(await as(doctor).post(`/careers/feedback/${f.id}/answers`, { role: 'manager', answers }))).toMatchObject({ status: 'Closed' });
    expect((await careers(nurse)).feedbacks[0]).toMatchObject({ status: 'Closed', selfAnswers: answers, managerAnswers: answers });
    expect((await careers(desk)).feedbacks).toEqual([]);
    const m = ok(await as(doctor).post('/careers/meetings', { title: 'Monthly 1-on-1', employeeId: ids.nurse, managerId: ids.doctor, scheduledAt: '2026-11-05T10:00:00.000Z' }), 201);
    expect((await as(nurse).post(`/careers/meetings/${m.id}/complete`, { notes: 'x' })).status).toBe(403);
    ok(await as(doctor).post(`/careers/meetings/${m.id}/complete`, { notes: 'Rota concerns', actionItems: 'Review night shifts' }));
    expect((await careers(nurse)).meetings[0]).toMatchObject({ status: 'Completed', notes: 'Rota concerns' });
  });

  it('applies a promotion only after its workflow approves it, then tracks the handover', async () => {
    const p = ok(await as(hr).post('/careers/promotions', { employeeId: ids.nurse, toJobPositionId: position.id, toCadre: 'GL 10', newSalary: 420000, effectiveDate: '2026-12-01', reason: 'Consistent ward leadership' }), 201);
    expect((await as(hr).post('/careers/promotions', { employeeId: ids.nurse, toCadre: 'GL 11', effectiveDate: '2026-12-01', reason: 'again' })).body.error.code).toBe('CHANGE_IN_FLIGHT');
    expect((await as(hr).post(`/careers/promotions/${p.id}/apply`)).status).toBe(409); // not approved yet
    // the starter promotion workflow: the employee's department head, then HR (salary under ₦500k)
    expect(await decideAll(doctor, p.id, 'reject')).toBe(1);
    expect((await as(hr).post(`/careers/promotions/${p.id}/apply`)).status).toBe(409);
    ok(await as(hr).post('/workflows/instances', { triggerType: 'promotion', reference: p.id }), 201); // resubmitted
    expect(await decideAll(doctor, p.id, 'approve')).toBe(1);
    expect(await decideAll(hr, p.id, 'approve')).toBe(0); // the HR officer who proposed it does not sign it off
    expect(await decideAll(hr2, p.id, 'approve')).toBe(1);
    ok(await as(hr).post(`/careers/promotions/${p.id}/apply`));
    const emp = (await people()).employees.find((e) => e.id === ids.nurse);
    expect(emp).toMatchObject({ jobPositionId: position.id, cadre: 'GL 10' });
    expect((await as(hr).post(`/careers/promotions/${p.id}/handover`, { complete: true })).status).toBe(409); // no plan yet
    ok(await as(hr).post(`/careers/promotions/${p.id}/handover`, { successorId: ids.desk, notes: 'Ward rota' }));
    ok(await as(hr).post(`/careers/promotions/${p.id}/handover`, { complete: true }));
    expect((await careers(hr)).promotions.find((x) => x.id === p.id)).toMatchObject({ status: 'Effective', newSalary: 420000, handoverStatus: 'Complete', successorId: ids.desk });
    expect((await careers(nurse)).promotions).toEqual([]); // HR's records
  });

  it('moves an employee to another branch once the transfer is approved', async () => {
    const t = ok(await as(hr).post('/careers/transfers', { employeeId: ids.nurse, toCompanyId: branch.id, effectiveDate: '2026-12-15', reason: 'Annex opening' }), 201);
    expect(await decideAll(doctor, t.id, 'approve')).toBe(1); // her line manager
    expect(await decideAll(hr2, t.id, 'approve')).toBe(1);
    ok(await as(hr).post(`/careers/transfers/${t.id}/apply`));
    expect((await people()).employees.find((e) => e.id === ids.nurse).companyId).toBe(branch.id);
    expect((await as(hr).post('/careers/transfers', { employeeId: ids.nurse, toCompanyId: branch.id, effectiveDate: '2027-01-01', reason: 'x' })).status).toBe(400); // already there
  });
});
