// Settings catalogs against real Postgres with RLS on: starter diagnosis list and patient categories,
// adding/editing/deactivating entries, the fixed national lists, permissions and isolation.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant } from './fixtures.js';

const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}) => request(app).post(url(path)).set('Authorization', who.auth).send(body),
    patch: (path, body = {}, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let admin; let doctor; let desk; let bAdmin;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });

beforeAll(async () => {
  A = await createTenant('catA');
  B = await createTenant('catB');
  admin = await member(A, ['HOSPITAL_ADMIN']);
  doctor = await member(A, ['DOCTOR']);
  desk = await member(A, ['RECEPTIONIST']);
  bAdmin = await member(B, ['HOSPITAL_ADMIN']);
});

describe('settings catalogs', () => {
  it('starts with the common diagnoses and lets the admin add, edit and deactivate', async () => {
    const list = (await as(doctor).get('/catalogs/diagnoses')).body.data.items;
    expect(list.find((d) => d.code === '1F40')).toMatchObject({ name: 'Malaria, uncomplicated', notifiable: true, active: true });
    const added = await as(admin).post('/catalogs/diagnoses', { code: 'ca40', name: 'Pneumonia', chapter: 'Respiratory' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.data).toMatchObject({ code: 'CA40', ncd: false });
    expect((await as(admin).post('/catalogs/diagnoses', { code: 'CA40', name: 'Again', chapter: 'x' })).body.error.code).toBe('DIAGNOSIS_CODE_IN_USE');
    expect((await as(doctor).post('/catalogs/diagnoses', { code: 'XX01', name: 'x', chapter: 'x' })).status).toBe(403);
    const edited = await as(admin).patch(`/catalogs/diagnoses/${added.body.data.id}`, { notifiable: true }, ifMatch(1));
    expect(edited.body.data).toMatchObject({ notifiable: true, version: 2 });
    await as(admin).patch(`/catalogs/diagnoses/${added.body.data.id}`, { active: false }, ifMatch(2));
    expect((await as(doctor).get('/catalogs/diagnoses')).body.data.items.find((d) => d.code === 'CA40')).toBeUndefined();
    expect((await as(admin).get('/catalogs/diagnoses?includeInactive=true')).body.data.items.find((d) => d.code === 'CA40')).toMatchObject({ active: false });
  });

  it('keeps patient categories with their fee exemption, and the national lists read-only', async () => {
    const cats = (await as(desk).get('/catalogs/categories')).body.data.items;
    expect(cats.find((c) => c.code === 'U5')).toMatchObject({ exempt: true, reason: 'Free child health' });
    expect((await as(admin).post('/catalogs/categories', { code: 'nhia', name: 'NHIA enrollee', exempt: false, reason: 'Insurance' })).body.data.code).toBe('NHIA');
    expect((await as(admin).get('/catalogs/vaccines')).body.data).toMatchObject({ editable: false, items: expect.arrayContaining([expect.objectContaining({ code: 'BCG' })]) });
    expect((await as(admin).get('/catalogs/diseases')).body.data.items.find((d) => d.code === 'MEAS')).toMatchObject({ immediate: true });
  });

  it('keeps hospitals apart', async () => {
    await as(admin).post('/catalogs/categories', { code: 'ONLYA', name: 'Only in A' });
    expect((await as(bAdmin).get('/catalogs/categories')).body.data.items.find((c) => c.code === 'ONLYA')).toBeUndefined();
    const ctx = { organizationId: A.organizationId, userId: admin.userId };
    await expect(withTenant(ctx, (tx) => tx.emrPatientCategory.updateMany({ where: { code: 'ONLYA' }, data: { code: 'RENAMED' } }))).rejects.toThrow();
  });
});
