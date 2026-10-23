// Growth monitoring and CMAM against real Postgres with RLS on: server classification and programme
// (OTP / SC / SFP), automatic CMAM enrolment from a growth visit, one open caseload entry, discharge,
// the under-five rule, permissions and isolation.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient } from './fixtures.js';

const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const today = () => new Date().toISOString().slice(0, 10);
const yearsAgo = (n) => new Date(Date.now() - n * 365.25 * 86_400_000).toISOString().slice(0, 10);
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let nurse; let desk; let admin; let bNurse;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const child = async (age = 2) => (await as(A).post('/patients', newPatient({ sex: 'FEMALE', dateOfBirth: yearsAgo(age) }))).body.data;
const growth = (patientId, muacCm, extra = {}) => as(nurse).post('/nutrition/growth', { patientId, visitDate: today(), weightKg: 9.4, heightCm: 82, muacCm, feeding: 'FAMILY_DIET', ...extra }, key());
const screen = (patientId, extra) => as(nurse).post('/nutrition/cmam', { patientId, screeningDate: today(), muacCm: 12, oedema: 'NONE', appetite: 'PASS', ...extra }, key());

beforeAll(async () => {
  A = await createTenant('nutA');
  B = await createTenant('nutB');
  nurse = await member(A, ['NURSE']);
  desk = await member(A, ['RECEPTIONIST']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  bNurse = await member(B, ['NURSE']);
});

describe('growth monitoring and CMAM', () => {
  it('classifies on the server and enrols a malnourished child in CMAM once', async () => {
    const kid = await child();
    const normal = await growth(kid.id, 13.4);
    expect(normal.body.data).toMatchObject({ classification: 'NORMAL', enrolledInCmam: false });
    const sam = await growth(kid.id, 11.2);
    expect(sam.status, JSON.stringify(sam.body)).toBe(201);
    expect(sam.body.data).toMatchObject({ classification: 'SAM', enrolledInCmam: true });
    const caseload = (await as(nurse).get(`/nutrition/cmam?open=true&patientId=${kid.id}`)).body.data.items;
    expect(caseload).toEqual([expect.objectContaining({ classification: 'SAM', programme: 'OTP', source: 'CHILD_HEALTH', growthVisitId: sam.body.data.id })]);
    // Already in the caseload: the next malnourished visit does not enrol again, and a direct screening is refused.
    expect((await growth(kid.id, 11.0)).body.data.enrolledInCmam).toBe(false);
    expect((await screen(kid.id, { muacCm: 11 })).body.error.code).toBe('CHILD_ALREADY_IN_CMAM');

    // Discharge once with a Sphere outcome; then she can be screened again.
    const entry = caseload[0];
    expect((await as(nurse).post(`/nutrition/cmam/${entry.id}/discharge`, { outcome: 'CURED' }, ifMatch(1))).body.data).toMatchObject({ outcome: 'CURED', dischargedByName: expect.any(String) });
    expect((await as(nurse).post(`/nutrition/cmam/${entry.id}/discharge`, { outcome: 'DEATH' }, ifMatch(2))).status).toBe(409);
    expect((await screen(kid.id, { muacCm: 12.1 })).body.data).toMatchObject({ classification: 'MAM', programme: 'SFP' });
  });

  it('sends SAM with a failed appetite test or severe oedema to the Stabilisation Centre', async () => {
    expect((await screen((await child()).id, { muacCm: 11.3, appetite: 'FAIL' })).body.data).toMatchObject({ classification: 'SAM', programme: 'SC' });
    expect((await screen((await child()).id, { muacCm: 13, oedema: 'SEVERE' })).body.data).toMatchObject({ classification: 'SAM', programme: 'SC' });
    expect((await screen((await child()).id, { muacCm: 13, oedema: 'MILD' })).body.data).toMatchObject({ classification: 'SAM', programme: 'OTP' });
    const normal = (await screen((await child()).id, { muacCm: 13.2 })).body.data;
    expect(normal).toMatchObject({ classification: 'NORMAL', programme: null });
    expect((await as(nurse).post(`/nutrition/cmam/${normal.id}/discharge`, { outcome: 'CURED' }, ifMatch(1))).status).toBe(409);
  });

  it('is for under-fives only, and keeps the desk and other hospitals out', async () => {
    expect((await growth((await child(7)).id, 13)).status).toBe(400);
    const kid = await child();
    const visit = (await growth(kid.id, 13)).body.data;
    expect((await as(desk).get('/nutrition/growth')).status).toBe(403);
    expect((await as(admin).get('/nutrition/cmam')).status).toBe(200);
    expect((await as(admin).post('/nutrition/growth', { patientId: kid.id, visitDate: today(), weightKg: 9, heightCm: 80, muacCm: 13, feeding: 'FORMULA' }, key())).status).toBe(403);
    expect((await as(bNurse).get('/nutrition/growth')).body.data.items.find((v) => v.id === visit.id)).toBeUndefined();
    const ctx = { organizationId: A.organizationId, userId: nurse.userId };
    await expect(withTenant(ctx, (tx) => tx.emrGrowthVisit.updateMany({ where: { id: visit.id }, data: { classification: 'SAM' } }))).rejects.toThrow();
  });
});
