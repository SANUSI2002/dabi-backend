// The audit trail screen against real Postgres: each event names its actor and their roles here, can be
// filtered by action, and stays within the tenant.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant, newPatient } from './fixtures.js';

const as = (who) => (path) => request(app).get(`/api/v1/emr/organizations/${who.organizationId}${path}`).set('Authorization', who.auth);
let A; let B; let nurse; let admin; let bAdmin;

beforeAll(async () => {
  A = await createTenant('audA');
  B = await createTenant('audB');
  nurse = { ...(await addMember(A, ['NURSE'])), organizationId: A.organizationId };
  admin = { ...(await addMember(A, ['HOSPITAL_ADMIN'])), organizationId: A.organizationId };
  bAdmin = { ...(await addMember(B, ['HOSPITAL_ADMIN'])), organizationId: B.organizationId };
});

describe('audit trail', () => {
  it('names the actor and their roles, and filters by action', async () => {
    await request(app).post(`/api/v1/emr/organizations/${A.organizationId}/patients`).set('Authorization', A.auth).send(newPatient());
    expect((await as(nurse)('/patients?limit=1')).status).toBe(200);
    const page = (await as(admin)('/audit-events?action=patient.listed&limit=20')).body.data;
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((e) => e.action === 'patient.listed')).toBe(true);
    expect(page.items.find((e) => e.actorUserId === nurse.userId)).toMatchObject({ actorName: expect.any(String), actorRoles: ['NURSE'] });
    expect((await as(admin)('/audit-events?action=DROP')).status).toBe(400);
    expect((await as(nurse)('/audit-events')).status).toBe(403);
    expect((await as(bAdmin)('/audit-events?limit=200')).body.data.items.find((e) => e.actorUserId === nurse.userId)).toBeUndefined();
  });
});
