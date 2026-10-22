// Module switches against real Postgres with RLS on: the package decides the products; within them the
// hospital admin switches modules and submodules off and on (never a core module, never a product the
// package lacks), the API refuses a switched-off module's requests while shared records stay reachable,
// and every change is version-checked and audited.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant } from './fixtures.js';

const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const api = (product) => (who) => {
  const url = (path) => `/api/v1/${product}/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}) => request(app).post(url(path)).set('Authorization', who.auth).send(body),
    put: (path, body = {}, headers = {}) => request(app).put(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};
const config = api('org-config'); const emr = api('emr'); const workforce = api('workforce');
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };

let A; let B; let admin; let nurse; let scientist; let hrB; let adminB;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const modules = async (who) => ok(await config(who).get('/modules'));
const save = (who, disabled, version) => config(who).put('/modules', { disabled }, ifMatch(version));

beforeAll(async () => {
  A = await createTenant('mdA'); // EMR only
  B = await createTenant('mdB', { modules: ['emr', 'workforce'] });
  admin = await member(A, ['HOSPITAL_ADMIN']);
  nurse = await member(A, ['NURSE']);
  scientist = await member(A, ['LAB_SCIENTIST']);
  adminB = await member(B, ['HOSPITAL_ADMIN']);
  hrB = await member(B, ['HR_OFFICER']);
});

describe('module switches', () => {
  it('shows what the package includes, with every module on until switched off', async () => {
    const data = await modules(nurse);
    expect(data.products).toEqual({ emr: true, workforce: false, accounting: false });
    expect(data.version).toBe(0);
    expect(data.editable).toBe(false);
    expect(data.modules.find((m) => m.key === 'emr.laboratory')).toMatchObject({ licensed: true, enabled: true, core: false });
    expect(data.modules.find((m) => m.key === 'workforce.payroll')).toMatchObject({ licensed: false, enabled: false });
    expect((await modules(admin)).editable).toBe(true);
  });

  it('switches a module off for the whole hospital, keeping shared records reachable, and back on', async () => {
    ok(await emr(scientist).get('/lab/tests'));
    expect((await save(nurse, ['emr.laboratory'], 0)).status).toBe(403);
    expect(ok(await save(admin, ['emr.laboratory'], 0))).toMatchObject({ switchedOff: ['emr.laboratory'], switchedOn: [] });
    const refused = await emr(scientist).get('/lab/tests');
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('MODULE_SWITCHED_OFF');
    expect((await emr(scientist).post('/lab/tests', {})).body.error.code).toBe('MODULE_SWITCHED_OFF'); // refused before anything else
    ok(await emr(nurse).get('/patients')); // shared clinical records are never switched off
    expect((await modules(nurse)).modules.find((m) => m.key === 'emr.laboratory').enabled).toBe(false);

    expect((await save(admin, [], 0)).status).toBe(412); // stale
    expect(ok(await save(admin, [], 1))).toMatchObject({ switchedOn: ['emr.laboratory'] });
    ok(await emr(scientist).get('/lab/tests'));
    const audit = ok(await emr(admin).get('/audit-events?action=modules.saved'));
    expect(audit.items?.length ?? audit.length).toBeGreaterThanOrEqual(2);
  });

  it('never switches off a core module, an unknown one, or one the package lacks', async () => {
    const { version } = await modules(admin);
    expect((await save(admin, ['emr.clinical'], version)).body.error.code).toBe('VALIDATION_FAILED');
    expect((await save(admin, ['emr.nothing'], version)).body.error.code).toBe('VALIDATION_FAILED');
    expect((await save(admin, ['workforce.payroll'], version)).body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringMatching(/not part of your package/) });
  });

  it('switches a submodule off on its own, leaving the rest of its module working', async () => {
    ok(await save(adminB, ['workforce.time.leave'], 0));
    expect((await workforce(hrB).post('/time/leave', {})).body.error.code).toBe('MODULE_SWITCHED_OFF');
    ok(await workforce(hrB).get('/time'));
    const data = await modules(hrB);
    expect(data.modules.find((m) => m.key === 'workforce.time')).toMatchObject({ enabled: true, submodules: expect.arrayContaining([expect.objectContaining({ key: 'workforce.time.leave', enabled: false })]) });
    // the other hospital is untouched
    ok(await emr(scientist).get('/lab/tests'));
    expect((await modules(admin)).disabled).toEqual([]);
  });
});
