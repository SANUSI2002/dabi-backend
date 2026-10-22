// The EMR's configurable lists against real Postgres with RLS on: appointment types, transfer reasons,
// store item categories and equipment categories are the hospital's own (Settings → Master Data). A value
// the hospital adds is accepted, one it never added is refused, and one it switches off is refused for
// new records.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant, newPatient } from './fixtures.js';

const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const api = (base) => (who) => {
  const url = (path) => `/api/v1/${base}/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    patch: (path, body = {}, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};
const emr = api('emr'); const config = api('org-config');
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const soon = () => new Date(Date.now() + 3 * 3_600_000).toISOString();

let A; let admin; let desk; let officer; let engineer;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const addTo = async (list, body) => ok(await config(admin).post(`/master-data/${list}`, body), 201);
const refused = (res) => { expect(res.status, JSON.stringify(res.body)).toBe(400); expect(res.body.error.message).toMatch(/Master Data/); };

beforeAll(async () => {
  A = await createTenant('clA');
  admin = await member(A, ['HOSPITAL_ADMIN']);
  desk = await member(A, ['RECEPTIONIST']);
  officer = await member(A, ['INVENTORY_OFFICER']);
  engineer = await member(A, ['HOSPITAL_ADMIN']);
});

describe("the hospital's own lists", () => {
  it('books a type of appointment the hospital added, which checks in at the vitals station', async () => {
    const patient = ok(await emr(desk).post('/patients', newPatient()), 201);
    refused(await emr(desk).post('/appointments', { patientId: patient.id, scheduledAt: soon(), type: 'DENTAL' }, key()));
    await addTo('appointment-types', { label: 'Dental', code: 'DENTAL' });
    expect(ok(await emr(desk).post('/appointments', { patientId: patient.id, scheduledAt: soon(), type: 'DENTAL' }, key()), 201)).toMatchObject({ type: 'DENTAL' });
  });

  it('records a transfer reason the hospital added, and refuses one it switched off', async () => {
    const transfer = (reason) => emr(desk).post('/transfers', { direction: 'IN', patientName: 'Halima Musa', facility: 'General Hospital, Ikorodu', reason }, key());
    refused(await transfer('Insurance network change'));
    await addTo('transfer-reasons', { label: 'Insurance network change' });
    ok(await transfer('Insurance network change'), 201);
    const relocation = ok(await config(admin).get('')).data['transfer-reasons'].find((i) => i.label === 'Relocation');
    ok(await config(admin).patch(`/master-data/transfer-reasons/${relocation.id}`, { active: false }, ifMatch(relocation.version)));
    refused(await transfer('Relocation'));
  });

  it('files store items and equipment under categories the hospital added', async () => {
    refused(await emr(officer).post('/stores/items', { sku: 'DRS-1', name: 'Wound dressing pack', category: 'Dressings', unit: 'pack' }));
    await addTo('store-item-categories', { label: 'Dressings' });
    expect(ok(await emr(officer).post('/stores/items', { sku: 'DRS-1', name: 'Wound dressing pack', category: 'Dressings', unit: 'pack' }), 201)).toMatchObject({ category: 'Dressings' });

    const asset = (category) => emr(engineer).post('/equipment/assets', { tag: `t-${randomUUID().slice(0, 6)}`, name: 'Dental chair', category, location: 'Dental clinic', commissionedOn: daysAgo(400), lastServicedOn: daysAgo(30), serviceIntervalDays: 180 }, key());
    refused(await asset('Dental'));
    await addTo('equipment-categories', { label: 'Dental' });
    ok(await asset('Dental'), 201);
  });
});
