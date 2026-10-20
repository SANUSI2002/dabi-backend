// Hiring and exits against real Postgres with RLS on: a requisition's pipeline from application to
// hire, interviews, rejection into the talent pool and back into recruitment, vacancy requests raised
// by a department head and decided through the vacancy workflow, onboarding through HR review to a
// real employee record, and offboarding that deactivates the employee. Who may do what.
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
    put: (path, body = {}, headers = {}) => request(app).put(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let hr; let hr2; let doctor; let nurse; let ids; let dept; let position;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const hiring = async (who) => (await as(who).get('/hiring')).body.data;
const workflows = async (who) => (await as(who).get('/workflows')).body.data;
const people = async () => (await as(hr).get('/people')).body.data;
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };
/** Decides every step of a request that is waiting on `who`. */
const decideAll = async (who, reference, decision, comment) => {
  const data = await workflows(who);
  const inst = data.instances.find((i) => i.reference === reference && i.status === 'Running');
  for (const step of data.inbox.filter((x) => x.instanceId === inst.id)) ok(await as(who).post(`/workflows/instances/${inst.id}/decide`, { nodeId: step.nodeId, decision, comment }));
};

beforeAll(async () => {
  A = await createTenant('whA', { modules: ['workforce'] });
  hr = await member(A, ['HR_OFFICER']);
  hr2 = await member(A, ['HR_OFFICER']);
  doctor = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  await as(hr).post('/people/employees/import-members');
  const emps = (await people()).employees;
  const idOf = (who) => emps.find((e) => e.userId === who.userId).id;
  ids = { hr: idOf(hr), hr2: idOf(hr2), doctor: idOf(doctor), nurse: idOf(nurse) };
  dept = ok(await as(hr).post('/people/departments', { name: 'Laboratory', code: 'LAB', hodId: ids.doctor }), 201);
  position = ok(await as(hr).post('/people/job-positions', { name: 'Medical Laboratory Scientist', departmentId: dept.id }), 201);
});

describe('hiring and exits', () => {
  let requisition; let ada; let bola;

  it('runs a requisition pipeline from application to hire, with interviews', async () => {
    expect((await as(nurse).post('/hiring/requisitions', { title: 'x', vacancy: 1, startDate: '2026-11-01' })).status).toBe(403);
    requisition = ok(await as(hr).post('/hiring/requisitions', { title: 'Lab Scientist', departmentId: dept.id, jobPositionId: position.id, vacancy: 2, startDate: '2026-11-01' }), 201);
    ada = ok(await as(hr).post('/hiring/candidates', { requisitionId: requisition.id, name: 'Ada Obi', email: 'ada@applicant.test', phone: '0800', source: 'Application' }), 201);
    bola = ok(await as(hr).post('/hiring/candidates', { requisitionId: requisition.id, name: 'Bola Ade', email: 'bola@applicant.test', source: 'Referral', referredBy: ids.nurse }), 201);
    let data = await hiring(hr);
    const stages = data.stages.filter((s) => s.requisitionId === requisition.id);
    expect(stages.map((s) => `${s.name}:${s.type}`)).toEqual(['Applied:Applied', 'Screening:Test', 'Interview:Interview', 'Hired:Hired']);
    expect(data.candidates.find((c) => c.id === bola.id)).toMatchObject({ referredBy: ids.nurse, stageId: stages[0].id, rating: 0 });
    ok(await as(hr).post(`/hiring/candidates/${ada.id}/move`, { stageId: stages[2].id }));
    ok(await as(hr).post(`/hiring/candidates/${ada.id}/rate`, { rating: 4 }));
    const iv = ok(await as(hr).post('/hiring/interviews', { candidateId: ada.id, scheduledAt: '2026-11-03T09:00:00.000Z', interviewerIds: [ids.doctor], notes: 'Bench test' }), 201);
    ok(await as(hr).post(`/hiring/interviews/${iv.id}/complete`, { feedback: 'Strong haematology' }));
    expect((await as(hr).post(`/hiring/interviews/${iv.id}/complete`, { feedback: 'again' })).status).toBe(409);
    ok(await as(hr).post(`/hiring/candidates/${ada.id}/move`, { stageId: stages[3].id }));
    ok(await as(hr).post(`/hiring/candidates/${ada.id}/hire`));
    data = await hiring(hr);
    expect(data.candidates.find((c) => c.id === ada.id)).toMatchObject({ hired: true, rating: 4, stageId: stages[3].id });
    expect(data.interviews.find((i) => i.id === iv.id)).toMatchObject({ status: 'Completed', feedback: 'Strong haematology' });
    expect((await hiring(nurse)).candidates).toEqual([]); // not HR
  });

  it('parks a rejected candidate in the talent pool and brings them back into recruitment', async () => {
    ok(await as(hr).post(`/hiring/candidates/${bola.id}/reject`, { reason: 'Underqualified' }));
    expect((await as(hr).post(`/hiring/candidates/${bola.id}/move`, { stageId: (await hiring(hr)).stages[0].id })).status).toBe(409);
    const t = ok(await as(hr).post('/hiring/talent-pool', { candidateId: bola.id, skillZone: 'Laboratory', reason: 'Underqualified' }), 201);
    ok(await as(hr).post(`/hiring/talent-pool/${t.id}/notes`, { text: 'Revisit after MLSCN licence' }), 201);
    ok(await as(hr).post(`/hiring/talent-pool/${t.id}/documents`, { type: 'Curriculum Vitae', filename: 'bola-cv.pdf', sizeKb: 120 }), 201);
    const taken = ok(await as(hr).post(`/hiring/talent-pool/${t.id}/take-to-recruitment`, { requisitionId: requisition.id, statusCode: 'SHORTLIST', statusLabel: 'Shortlisted', stageType: 'Test' }));
    const data = await hiring(hr);
    const entry = data.talentPool.find((x) => x.id === t.id);
    expect(entry).toMatchObject({ candidateName: 'Bola Ade', skillZone: 'Laboratory', notes: [{ text: 'Revisit after MLSCN licence', by: ids.hr }], documents: [{ filename: 'bola-cv.pdf', type: 'Curriculum Vitae', sizeKb: 120 }] });
    expect(entry.history.map((h) => h.event)).toEqual(['Moved to recruitment', 'Added to talent pool']);
    expect(entry.takenToRecruitment).toMatchObject({ requisitionId: requisition.id, candidateId: taken.candidateId, statusCode: 'SHORTLIST' });
    const stage = data.stages.find((s) => s.requisitionId === requisition.id && s.name === 'Shortlisted');
    expect(stage).toMatchObject({ type: 'Test', sequence: 4 });
    expect(data.candidates.find((c) => c.id === taken.candidateId)).toMatchObject({ source: 'Inside software', stageId: stage.id });
    expect((await as(hr).post(`/hiring/talent-pool/${t.id}/take-to-recruitment`, { requisitionId: requisition.id, statusCode: 'X', statusLabel: 'X', stageType: 'Test' })).status).toBe(409);
  });

  it('lets a department head raise a vacancy, decided through the vacancy workflow', async () => {
    const draft = { departmentId: dept.id, jobPositionId: position.id, roleTitle: 'Lab Scientist', headcount: 1, reason: 'Night cover', salaryMin: 280000, salaryMax: 360000 };
    expect((await as(nurse).post('/hiring/vacancies', draft)).status).toBe(403); // not the department's head
    const v = ok(await as(doctor).post('/hiring/vacancies', draft), 201);
    expect((await hiring(nurse)).vacancies).toEqual([]);
    let mine = (await hiring(doctor)).vacancies.find((x) => x.id === v.id);
    expect(mine).toMatchObject({ status: 'Draft', raisedBy: ids.doctor, raisedByMe: true });
    ok(await as(doctor).patch(`/hiring/vacancies/${v.id}`, { headcount: 2 }, ifMatch(mine.version)));
    expect((await as(nurse).post('/workflows/instances', { triggerType: 'vacancy', reference: v.id })).status).toBe(403);
    ok(await as(doctor).post('/workflows/instances', { triggerType: 'vacancy', reference: v.id }), 201);
    mine = (await hiring(doctor)).vacancies.find((x) => x.id === v.id);
    expect(mine.status).toBe('Submitted');
    expect((await as(doctor).patch(`/hiring/vacancies/${v.id}`, { headcount: 3 }, ifMatch(mine.version))).status).toBe(409); // in review
    await decideAll(hr, v.id, 'reject', 'Budget not approved this quarter');
    mine = (await hiring(doctor)).vacancies.find((x) => x.id === v.id);
    expect(mine).toMatchObject({ status: 'Rejected', rejectionReason: 'Budget not approved this quarter' });
    ok(await as(doctor).post('/workflows/instances', { triggerType: 'vacancy', reference: v.id }), 201); // revised and resubmitted
    await decideAll(hr2, v.id, 'approve');
    mine = (await hiring(hr)).vacancies.find((x) => x.id === v.id);
    expect(mine.status).toBe('Approved');
    expect(mine.rejectionReason).toBeUndefined();
    ok(await as(hr).post(`/hiring/vacancies/${v.id}/filled`));
    const other = ok(await as(doctor).post('/hiring/vacancies', draft), 201);
    ok(await as(doctor).post('/workflows/instances', { triggerType: 'vacancy', reference: other.id }), 201);
    ok(await as(doctor).post(`/hiring/vacancies/${other.id}/cancel`));
    expect((await workflows(hr)).instances.find((i) => i.reference === other.id).status).toBe('Cancelled');
  });

  it('onboards a hire through HR review into a real employee record', async () => {
    const p = ok(await as(hr).post('/hiring/onboarding', { candidateId: ada.id }), 201);
    expect((await as(hr).post('/hiring/onboarding', { candidateId: ada.id })).status).toBe(409);
    expect((await as(hr).post(`/hiring/onboarding/${p.id}/advance`)).status).toBe(409); // tasks open
    expect((await as(hr).post(`/hiring/onboarding/${p.id}/tasks`, { taskId: 'ob-t0' })).status).toBe(409); // needs its document
    ok(await as(hr).post(`/hiring/onboarding/${p.id}/documents`, { taskId: 'ob-t0', title: 'NIN-Ada-Obi.pdf' }), 201);
    ok(await as(hr).post(`/hiring/onboarding/${p.id}/documents`, { taskId: 'ob-t1', title: 'Offer-signed.pdf' }), 201);
    ok(await as(hr).post(`/hiring/onboarding/${p.id}/tasks`, { taskId: 'ob-t2' }));
    ok(await as(hr).post(`/hiring/onboarding/${p.id}/advance`));
    for (const [tasks] of [[['ob-t3', 'ob-t4']], [['ob-t6']]]) {
      for (const taskId of tasks) ok(await as(hr).post(`/hiring/onboarding/${p.id}/tasks`, { taskId }));
      ok(await as(hr).post(`/hiring/onboarding/${p.id}/advance`));
    }
    for (const taskId of ['ob-t8', 'ob-t9']) ok(await as(hr).post(`/hiring/onboarding/${p.id}/tasks`, { taskId }));
    expect((await as(hr).post('/workflows/instances', { triggerType: 'onboarding', reference: p.id })).status).toBe(409); // terms not set
    ok(await as(hr).patch(`/hiring/onboarding/${p.id}`, { resumptionDate: '2026-12-01', basicSalary: 320000 }));
    expect((await as(hr).post(`/hiring/onboarding/${p.id}/convert`, { role: 'Lab Scientist' })).status).toBe(409); // not reviewed
    ok(await as(hr).post('/workflows/instances', { triggerType: 'onboarding', reference: p.id }), 201);
    expect((await workflows(hr)).inbox).toEqual([]); // HR does not review its own submission
    await decideAll(hr2, p.id, 'approve');
    const done = ok(await as(hr).post(`/hiring/onboarding/${p.id}/convert`, { role: 'Lab Scientist', cadre: 'GL 08' }), 201);
    const emp = (await people()).employees.find((e) => e.id === done.employeeId);
    expect(emp).toMatchObject({ name: 'Ada Obi', role: 'Lab Scientist', cadre: 'GL 08', email: 'ada@applicant.test', departmentId: dept.id, jobPositionId: position.id, hireDate: '2026-12-01', status: 'ACTIVE' });
    expect((await people()).documents.filter((d) => d.employeeId === emp.id).map((d) => [d.title, d.status]).sort()).toEqual([['NIN-Ada-Obi.pdf', 'Approved'], ['Offer-signed.pdf', 'Approved']]);
    const data = await hiring(hr);
    expect(data.onboarding.find((x) => x.id === p.id)).toMatchObject({ employeeId: emp.id, basicSalary: 320000, resumptionDate: '2026-12-01' });
    expect(data.candidates.find((c) => c.id === ada.id).convertedEmployeeId).toBe(emp.id);
    expect((await as(hr).post(`/hiring/onboarding/${p.id}/convert`, { role: 'x' })).status).toBe(409);
    // the offer letter starts under the hospital's name and is HR's to edit
    expect(data.offerLetterTemplate).toMatchObject({ version: 0, text: expect.stringContaining('OFFER OF EMPLOYMENT') });
    ok(await as(hr).put('/hiring/offer-letter-template', { text: 'Dear {{candidate_name}}' }, ifMatch(0)));
    expect((await as(hr).put('/hiring/offer-letter-template', { text: 'stale' }, ifMatch(0))).status).toBe(412);
    expect((await hiring(hr)).offerLetterTemplate).toEqual({ text: 'Dear {{candidate_name}}', version: 1 });
  });

  it('walks an exit to archive and deactivates the employee', async () => {
    const c = ok(await as(hr).post('/hiring/offboarding', { employeeId: ids.nurse, reason: 'Relocation', lastWorkingDate: '2026-12-31' }), 201);
    expect((await as(hr).post('/hiring/offboarding', { employeeId: ids.nurse, reason: 'Relocation', lastWorkingDate: '2026-12-31' })).status).toBe(409);
    ok(await as(hr).post(`/hiring/offboarding/${c.id}/advance`)); // notice → exit interview
    expect((await as(hr).post(`/hiring/offboarding/${c.id}/advance`)).status).toBe(409);
    ok(await as(hr).patch(`/hiring/offboarding/${c.id}`, { exitInterviewNotes: 'Moving to Abuja' }));
    ok(await as(hr).post(`/hiring/offboarding/${c.id}/advance`));
    ok(await as(hr).patch(`/hiring/offboarding/${c.id}`, { handoverNotes: 'Ward keys and rota to Grace' }));
    ok(await as(hr).post(`/hiring/offboarding/${c.id}/advance`));
    ok(await as(hr).patch(`/hiring/offboarding/${c.id}`, { fnfAmount: 145000 }));
    ok(await as(hr).post(`/hiring/offboarding/${c.id}/advance`)); // → farewell
    ok(await as(hr).post(`/hiring/offboarding/${c.id}/advance`)); // → archived
    const data = await hiring(hr);
    expect(data.offboarding.find((x) => x.id === c.id)).toMatchObject({ status: 'Completed', currentStageId: 'ofb-st5', fnfSettled: true, fnfAmount: 145000 });
    expect((await people()).employees.find((e) => e.id === ids.nurse).status).toBe('INACTIVE');
    expect((await as(hr).patch(`/hiring/offboarding/${c.id}`, { handoverNotes: 'late' })).status).toBe(409);
  });
});
