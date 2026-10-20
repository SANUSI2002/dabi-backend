// Organization configuration against real Postgres with RLS on: starter lists and letter templates per
// organization, each list edited only by its product's owner, starter items kept (switched off, not
// removed), terminology with optimistic locking, and letters rendered by the server and logged.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant } from './fixtures.js';

const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const as = (who) => {
  const url = (path) => `/api/v1/org-config/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}) => request(app).post(url(path)).set('Authorization', who.auth).send(body),
    patch: (path, body = {}, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
    put: (path, body = {}, headers = {}) => request(app).put(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };

let A; let B; let hr; let admin; let nurse; let emrOnlyAdmin;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const config = async (who) => (await as(who).get('')).body.data;

beforeAll(async () => {
  A = await createTenant('ocA', { modules: ['emr', 'workforce'] });
  B = await createTenant('ocB', { modules: ['emr'] }); // an EMR-only hospital still has its lists
  hr = await member(A, ['HR_OFFICER']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  nurse = await member(A, ['NURSE']);
  emrOnlyAdmin = await member(B, ['HOSPITAL_ADMIN']);
});

describe('organization configuration', () => {
  it('starts every organization with its own lists and letter templates', async () => {
    const data = await config(nurse);
    expect(data.data['leave-types'].map((i) => i.code)).toContain('ANNUAL');
    expect(data.data['ward-types'].length).toBeGreaterThan(0);
    expect(data.templates.map((t) => t.key)).toContain('offer');
    expect(data.categories.find((c) => c.key === 'leave-types').editable).toBe(false);
    expect(data.letters).toEqual([]); // HR records
    expect((await config(emrOnlyAdmin)).data['bed-types'].length).toBeGreaterThan(0);
  });

  it('lets each product owner edit its lists, and keeps starter items', async () => {
    expect((await as(nurse).post('/master-data/leave-types', { label: 'Exam Leave', code: 'EXAM' })).status).toBe(403);
    const added = ok(await as(hr).post('/master-data/leave-types', { label: 'Exam Leave', code: 'EXAM', meta: { paid: true } }), 201);
    expect((await as(hr).post('/master-data/leave-types', { label: 'exam leave' })).body.error.code).toBe('MASTER_ITEM_IN_USE');
    expect((await as(hr).post('/master-data/id-types', { label: 'Staff card' })).status).toBe(403); // platform-wide: admin's
    expect((await as(hr).post('/master-data/ward-types', { label: 'Burns' })).status).toBe(403); // an EMR list
    ok(await as(admin).post('/master-data/id-types', { label: 'Staff card' }), 201);
    let leave = (await config(hr)).data['leave-types'];
    const annual = leave.find((i) => i.code === 'ANNUAL');
    expect((await as(hr).post(`/master-data/leave-types/${annual.id}/remove`)).status).toBe(409); // starter
    ok(await as(hr).patch(`/master-data/leave-types/${annual.id}`, { active: false }, ifMatch(annual.version)));
    ok(await as(hr).post(`/master-data/leave-types/${added.id}/remove`));
    leave = (await config(hr)).data['leave-types'];
    expect(leave.find((i) => i.code === 'ANNUAL').active).toBe(false);
    expect(leave.some((i) => i.code === 'EXAM')).toBe(false);
    ok(await as(hr).post('/master-data/leave-types', { label: 'Exam Leave', code: 'EXAM' }), 201); // the name is free again
  });

  it('saves terminology with its version', async () => {
    expect((await as(nurse).put('/terminology', { overrides: { hod: { singular: 'Unit Head' } } }, ifMatch(0))).status).toBe(403);
    ok(await as(admin).put('/terminology', { overrides: { hod: { singular: 'Unit Head', plural: 'Unit Heads' } } }, ifMatch(0)));
    expect((await as(hr).put('/terminology', { overrides: {} }, ifMatch(0))).status).toBe(412);
    expect((await config(nurse)).terms).toMatchObject({ overrides: { hod: { singular: 'Unit Head', plural: 'Unit Heads' } }, version: 1 });
    expect((await as(admin).put('/terminology', { overrides: { boss: { singular: 'x' } } }, ifMatch(1))).status).toBe(400);
  });

  it('renders letters on the server and keeps them as rendered', async () => {
    const tpl = (await config(hr)).templates.find((t) => t.key === 'missing-document');
    ok(await as(hr).patch('/letter-templates/missing-document', { body: 'Dear {{employee_name}}, please bring: {{document_list}} by {{deadline}}.' }, ifMatch(tpl.version)));
    const letter = ok(await as(hr).post('/letters', { templateKey: 'missing-document', title: 'Outstanding Document Notice — Ada Obi', reference: 'onb-1', data: { employee_name: 'Ada Obi', document_list: '• NIN slip' } }), 201);
    expect((await as(nurse).post('/letters', { templateKey: 'offer', data: {} })).status).toBe(403);
    ok(await as(hr).post(`/letters/${letter.id}/sent`, { to: 'ada@applicant.test' }));
    expect((await as(hr).post(`/letters/${letter.id}/sent`, { to: 'again' })).status).toBe(409);
    const tpl2 = (await config(hr)).templates.find((t) => t.key === 'missing-document');
    ok(await as(hr).patch('/letter-templates/missing-document', { body: 'Changed later' }, ifMatch(tpl2.version)));
    const logged = (await config(hr)).letters.find((l) => l.id === letter.id);
    expect(logged).toMatchObject({ rendered: 'Dear Ada Obi, please bring: • NIN slip by ________.', reference: 'onb-1', sentTo: 'ada@applicant.test' });
    expect((await config(nurse)).letters).toEqual([]);
  });

  it('keeps each organization to its own configuration', async () => {
    expect((await as({ ...hr, organizationId: B.organizationId }).get('')).status).toBe(403);
    expect((await config(emrOnlyAdmin)).data['leave-types'].some((i) => i.code === 'EXAM')).toBe(false);
  });
});
