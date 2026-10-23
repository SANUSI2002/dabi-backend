// Workforce people & organization against real Postgres with RLS on: the 'workforce' product gate,
// starter structure, employees (sensitive fields only for HR), reporting lines without cycles,
// departments with logged leadership changes, documents, append-only records, import of members,
// permissions and isolation.
import { randomUUID as randomId } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
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

let A; let B; let EmrOnly; let hr; let admin; let nurse; let bHr; let emrAdmin;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const people = async (who = hr) => (await as(who).get('/people')).body.data;
const hire = (extra = {}) => as(hr).post('/people/employees', { name: 'Chinwe Obi', role: 'Nurse', cadre: 'Nursing Officer II', hireDate: '2024-03-01', ...extra });

beforeAll(async () => {
  A = await createTenant('wfA', { modules: ['emr', 'workforce'] });
  B = await createTenant('wfB', { modules: ['workforce'] });
  EmrOnly = await createTenant('wfC', { modules: ['emr'] });
  hr = await member(A, ['HR_OFFICER']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  nurse = await member(A, ['NURSE']);
  bHr = await member(B, ['HR_OFFICER']);
  emrAdmin = { ...EmrOnly };
});

describe('workforce people', () => {
  it('needs the workforce product, and starts each organization with its headquarters and lists', async () => {
    expect((await as(emrAdmin).get('/people')).body.error.code).toBe('WORKFORCE_ACCESS_DENIED');
    expect((await as(nurse).get('/people')).status).toBe(403);
    const first = await people();
    expect(first.companies).toEqual([expect.objectContaining({ code: 'HQ', isHeadquarters: true, name: expect.stringMatching(/wfA Hospital/) })]);
    expect(first.employeeTypes.map((t) => t.name)).toContain('Locum');
    expect(first.actionTypes.find((t) => t.name === 'Suspension')).toMatchObject({ blockOption: true });
  });

  it('hires employees, keeps bank details for HR, and refuses reporting cycles', async () => {
    const boss = (await hire({ name: 'Dr Bello', role: 'Medical Officer', bankName: 'GTBank', accountNumber: '0123456789' })).body.data;
    expect(boss).toMatchObject({ status: 'ACTIVE', accountNumber: '0123456789', companyId: expect.any(String) });
    const staff = (await hire({ reportingManagerId: boss.id })).body.data;
    expect((await as(hr).patch(`/people/employees/${boss.id}`, { reportingManagerId: staff.id }, ifMatch(boss.version))).body.error.message).toMatch(/report to themselves/);
    expect((await hire({ accountNumber: '123' })).status).toBe(400);
    // The screen may name the new record itself; a repeated id is a conflict, never a second record.
    const own = randomId();
    expect((await hire({ id: own, name: 'Named by the screen' })).body.data.id).toBe(own);
    expect((await hire({ id: own, name: 'Again' })).status).toBe(409);
    const seenByAdmin = (await people(admin)).employees.find((e) => e.id === boss.id);
    expect(seenByAdmin.accountNumber).toBeUndefined();
    expect((await as(admin).post('/people/employees', { name: 'X', role: 'Porter', hireDate: '2024-01-01', bankName: 'Access' })).status).toBe(403);
    const left = await as(hr).patch(`/people/employees/${staff.id}`, { status: 'INACTIVE' }, ifMatch(staff.version));
    expect(left.body.data.status).toBe('INACTIVE');
    expect((await as(hr).patch(`/people/employees/${staff.id}`, { status: 'ACTIVE' }, ifMatch(staff.version))).status).toBe(412);
  });

  it('runs departments with members and a logged leadership history', async () => {
    const lead = (await hire({ name: 'Matron Ada' })).body.data;
    const next = (await hire({ name: 'Matron Joy' })).body.data;
    const hq = (await people()).companies[0];
    const created = await as(hr).post('/people/departments', { name: 'Nursing', code: 'nurs', companyIds: [hq.id], hodId: lead.id });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await as(hr).post('/people/departments', { name: 'Again', code: 'NURS' })).body.error.code).toBe('HR_CODE_IN_USE');
    const id = created.body.data.id;
    let dept = (await people()).departments.find((d) => d.id === id);
    expect(dept).toMatchObject({ code: 'NURS', hodId: lead.id, staffIds: [lead.id] });
    expect((await as(hr).post(`/people/departments/${id}/leader`, { role: 'hod', employeeId: next.id, effectiveDate: '2026-10-01', reason: 'Rotation' }, ifMatch(dept.version))).status).toBe(200);
    await as(hr).post(`/people/departments/${id}/members`, { employeeId: lead.id });
    const snapshot = await people();
    dept = snapshot.departments.find((d) => d.id === id);
    expect(dept).toMatchObject({ hodId: next.id });
    expect(dept.staffIds.sort()).toEqual([lead.id, next.id].sort());
    expect(snapshot.hodChanges.find((h) => h.departmentId === id)).toMatchObject({ previousStaffId: lead.id, newStaffId: next.id, reason: 'Rotation', changedBy: expect.any(String) });
    await as(hr).post(`/people/departments/${id}/members/remove`, { employeeId: next.id });
    expect((await people()).departments.find((d) => d.id === id)).toMatchObject({ hodId: null, staffIds: [lead.id] });
    const pos = (await as(hr).post('/people/job-positions', { name: 'Ward Nurse', departmentId: id })).body.data;
    expect((await as(hr).post('/people/job-roles', { name: 'Night lead', jobPositionId: pos.id })).status).toBe(201);
    expect((await as(hr).patch(`/people/departments/${id}`, { parentDepartmentId: id }, ifMatch(dept.version + 1))).status).toBe(400);
  });

  it('requests, uploads and reviews documents, and keeps notes, bonus and discipline as a log', async () => {
    const e = (await hire({ name: 'Tolu Ade' })).body.data;
    await as(hr).post('/people/documents', { employeeIds: [e.id], title: 'Nursing licence', category: 'Licence', notifyBeforeDays: 60 });
    let doc = (await people()).documents.find((d) => d.employeeId === e.id);
    expect((await as(hr).post(`/people/documents/${doc.id}/review`, { status: 'Approved' }, ifMatch(1))).status).toBe(409);
    await as(hr).post(`/people/documents/${doc.id}/upload`, { issueDate: '2026-01-01', expiryDate: '2026-12-31' }, ifMatch(1));
    expect((await as(hr).post(`/people/documents/${doc.id}/review`, { status: 'Rejected' }, ifMatch(2))).status).toBe(400);
    await as(hr).post(`/people/documents/${doc.id}/review`, { status: 'Rejected', rejectReason: 'Blurred scan' }, ifMatch(2));
    doc = (await people()).documents.find((d) => d.id === doc.id);
    expect(doc).toMatchObject({ status: 'Rejected', rejectReason: 'Blurred scan', expiryDate: '2026-12-31' });

    await as(hr).post(`/people/employees/${e.id}/notes`, { note: 'Excellent patient feedback' });
    await as(hr).post(`/people/employees/${e.id}/bonus`, { delta: 10, reason: 'Covered extra shifts' });
    await as(hr).post(`/people/employees/${e.id}/bonus`, { delta: -3, reason: 'Late twice' });
    const types = (await people()).actionTypes;
    expect((await as(hr).post('/people/disciplinary-actions', { employeeIds: [e.id], actionTypeId: types[0].id, description: 'Late to handover', unit: 'Days', amount: 0, startDate: '2026-10-10' })).status).toBe(201);
    const s = await people();
    expect(s.notes.find((n) => n.employeeId === e.id)).toMatchObject({ note: 'Excellent patient feedback', by: expect.any(String) });
    expect(s.bonusPoints.find((b) => b.employeeId === e.id)).toMatchObject({ points: 7, history: [expect.objectContaining({ delta: -3 }), expect.objectContaining({ delta: 10 })] });
    const ctx = { organizationId: A.organizationId, userId: hr.userId };
    await expect(withTenant(ctx, (tx) => tx.wfEmployeeNote.updateMany({ where: { employeeId: e.id }, data: { note: 'edited' } }))).rejects.toThrow();
  });

  it('imports the organization members as employees once, and keeps organizations apart', async () => {
    const first = (await as(hr).post('/people/employees/import-members')).body.data.imported;
    expect(first).toBeGreaterThanOrEqual(3);
    expect((await as(hr).post('/people/employees/import-members')).body.data.imported).toBe(0);
    expect((await people()).employees.find((e) => e.userId === nurse.userId)).toMatchObject({ role: 'Nurse' });
    expect((await people(bHr)).employees.find((e) => e.userId === nurse.userId)).toBeUndefined();
    const someone = (await people()).employees[0];
    expect((await as(bHr).patch(`/people/employees/${someone.id}`, { name: 'Hijack' }, ifMatch(someone.version))).status).toBe(404);
  });
});
