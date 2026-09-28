// Real Postgres, row-level security on, every migration applied. Use-case ids refer to
// docs/emr-backend.md §6.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { dispatchPending, deliverDue, signPayload, MAX_ATTEMPTS } from '../../src/modules/emr/core/outbox.js';
import { addMember, createTenant, newPatient, prisma } from './fixtures.js';

const base = (tenant) => `/api/v1/emr/organizations/${tenant.organizationId}`;
const register = (tenant, body = newPatient(), headers = {}) =>
  request(app).post(`${base(tenant)}/patients`).set('Authorization', tenant.auth).set(headers).send(body);

let A;
let B;
let patientA;
beforeAll(async () => {
  A = await createTenant('alpha');
  B = await createTenant('bravo');
  const created = await register(A, newPatient({ nationalId: 'NIN-ALPHA-0001', phone: '+2348000000001' }));
  expect(created.status).toBe(201);
  patientA = created.body.data;
});

describe('tenant isolation', () => {
  it('UC-1: tenant B cannot list, search, read or change tenant A patients', async () => {
    const list = await request(app).get(`${base(B)}/patients?status=ALL`).set('Authorization', B.auth);
    expect(list.status).toBe(200);
    expect(list.body.data.items.map((p) => p.id)).not.toContain(patientA.id);

    const search = await request(app).get(`${base(B)}/patients?q=${patientA.medicalRecordNumber}`).set('Authorization', B.auth);
    expect(search.body.data.items).toHaveLength(0);

    const read = await request(app).get(`${base(B)}/patients/${patientA.id}`).set('Authorization', B.auth);
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe('PATIENT_NOT_FOUND');

    const write = await request(app).patch(`${base(B)}/patients/${patientA.id}`).set('Authorization', B.auth).set('If-Match', 'W/"1"').send({ phone: '+2348000000999' });
    expect(write.status).toBe(404);
    const untouched = await prisma.emrPatient.findUnique({ where: { id: patientA.id } });
    expect(untouched.phone).toBe('+2348000000001');
  });

  it('UC-1b: a token for tenant A on tenant B\'s URL is refused', async () => {
    const response = await request(app).get(`${base(B)}/patients`).set('Authorization', A.auth);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ORGANIZATION_ACCESS_DENIED');
  });

  it('UC-1c: row-level security filters even a query with no tenant filter', async () => {
    await register(B);
    const rows = await withTenant({ organizationId: A.organizationId }, (tx) => tx.emrPatient.findMany({ select: { organizationId: true } }));
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.organizationId))).toEqual(new Set([A.organizationId]));
  });

  it('UC-1d: inside tenant A a row for tenant B cannot be written', async () => {
    await expect(withTenant({ organizationId: A.organizationId }, (tx) => tx.emrPatient.create({
      data: { ...newPatient(), dateOfBirth: new Date('1990-01-01'), organizationId: B.organizationId, createdByUserId: A.userId },
    }))).rejects.toThrow();
  });

  it('UC-1e: the restricted role with no tenant set sees nothing', async () => {
    const count = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE sabi_emr_app');
      return tx.emrPatient.count();
    });
    expect(count).toBe(0);
  });

  it('refuses a malformed tenant id before touching the database', async () => {
    await expect(withTenant({ organizationId: "x' OR '1'='1" }, async () => 1)).rejects.toThrow('TENANT_CONTEXT_MISSING');
  });
});

describe('provisioning, entitlement and permissions', () => {
  it('UC-4: a newly approved tenant registers its first patient with no setup', async () => {
    const fresh = await createTenant('charlie');
    expect((await register(fresh)).status).toBe(201);
  });

  it('UC-6: a tenant without an EMR entitlement is refused', async () => {
    const noEmr = await createTenant('delta', { emr: false });
    const response = await request(app).get(`${base(noEmr)}/patients`).set('Authorization', noEmr.auth);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('EMR_ACCESS_DENIED');
  });

  it('UC-8: role permissions are enforced (receptionist registers; lab cannot list; receptionist cannot deactivate)', async () => {
    const receptionist = await addMember(A, ['RECEPTIONIST']);
    const lab = await addMember(A, ['LAB_SCIENTIST']);
    const asReception = { ...A, auth: receptionist.auth };
    expect((await register(asReception)).status).toBe(201);
    const labList = await request(app).get(`${base(A)}/patients`).set('Authorization', lab.auth);
    expect(labList.status).toBe(403);
    expect(labList.body.error.code).toBe('PERMISSION_DENIED');
    const deactivate = await request(app).post(`${base(A)}/patients/${patientA.id}/deactivate`).set('Authorization', receptionist.auth).set('If-Match', 'W/"1"').send({ reason: 'Test' });
    expect(deactivate.status).toBe(403);
  });

  it('UC-9: a suspended membership is refused on the next request', async () => {
    const nurse = await addMember(A, ['RECEPTIONIST']);
    expect((await request(app).get(`${base(A)}/patients`).set('Authorization', nurse.auth)).status).toBe(200);
    await prisma.organizationMembership.update({ where: { userId_organizationId: { userId: nurse.userId, organizationId: A.organizationId } }, data: { status: 'SUSPENDED' } });
    expect((await request(app).get(`${base(A)}/patients`).set('Authorization', nurse.auth)).status).toBe(403);
  });
});

describe('concurrency and idempotency', () => {
  it('UC-10/11: stale If-Match gets 412 with the current version; missing If-Match gets 428', async () => {
    const { body } = await register(A);
    const id = body.data.id;
    const url = `${base(A)}/patients/${id}`;
    const first = await request(app).patch(url).set('Authorization', A.auth).set('If-Match', 'W/"1"').send({ phone: '+2348011111111' });
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBe('W/"2"');
    const stale = await request(app).patch(url).set('Authorization', A.auth).set('If-Match', 'W/"1"').send({ phone: '+2348022222222' });
    expect(stale.status).toBe(412);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.headers.etag).toBe('W/"2"');
    expect((await prisma.emrPatient.findUnique({ where: { id } })).phone).toBe('+2348011111111');
    const missing = await request(app).patch(url).set('Authorization', A.auth).send({ phone: '+2348033333333' });
    expect(missing.status).toBe(428);
  });

  it('UC-12: a retried registration replays the same patient; the same key with a new body is refused', async () => {
    const body = newPatient();
    const key = `retry-${randomUUID()}`;
    const first = await register(A, body, { 'Idempotency-Key': key });
    const retry = await register(A, body, { 'Idempotency-Key': key });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(await prisma.emrPatient.count({ where: { medicalRecordNumber: body.medicalRecordNumber } })).toBe(1);
    const reused = await register(A, { ...body, givenName: 'Different' }, { 'Idempotency-Key': key });
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('UC-13: two simultaneous registrations with one MRN → one 201, one 409', async () => {
    const mrn = `MRN-RACE-${Date.now()}`;
    const results = await Promise.all([register(A, newPatient({ medicalRecordNumber: mrn })), register(A, newPatient({ medicalRecordNumber: mrn }))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409).body.error.code).toBe('MEDICAL_RECORD_NUMBER_IN_USE');
  });

  it('the same MRN is allowed in a different tenant; a national ID is unique per tenant', async () => {
    expect((await register(B, newPatient({ medicalRecordNumber: patientA.medicalRecordNumber }))).status).toBe(201);
    const dup = await register(A, newPatient({ nationalId: 'NIN-ALPHA-0001' }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('NATIONAL_ID_IN_USE');
  });
});

describe('patient lifecycle', () => {
  it('keyset pages never overlap; legacy page paging still works', async () => {
    const tenant = await createTenant('echo');
    for (let i = 0; i < 3; i += 1) await register(tenant);
    const one = await request(app).get(`${base(tenant)}/patients?limit=2`).set('Authorization', tenant.auth);
    expect(one.body.data.items).toHaveLength(2);
    const two = await request(app).get(`${base(tenant)}/patients?limit=2&cursor=${one.body.data.nextCursor}`).set('Authorization', tenant.auth);
    expect(two.body.data.items).toHaveLength(1);
    expect(two.body.data.nextCursor).toBeNull();
    const ids = [...one.body.data.items, ...two.body.data.items].map((p) => p.id);
    expect(new Set(ids).size).toBe(3);
    const legacy = await request(app).get(`${base(tenant)}/patients?page=1&limit=2`).set('Authorization', tenant.auth);
    expect(legacy.body.data.nextPage).toBe(2);
    const bad = await request(app).get(`${base(tenant)}/patients?cursor=not-a-cursor`).set('Authorization', tenant.auth);
    expect(bad.status).toBe(400);
  });

  it('deactivation hides the record from the default list and blocks edits until reactivated', async () => {
    const { body } = await register(A);
    const url = `${base(A)}/patients/${body.data.id}`;
    const off = await request(app).post(`${url}/deactivate`).set('Authorization', A.auth).set('If-Match', 'W/"1"').send({ reason: 'Duplicate registration' });
    expect(off.status).toBe(200);
    expect(off.body.data.status).toBe('INACTIVE');
    const list = await request(app).get(`${base(A)}/patients?q=${body.data.medicalRecordNumber}`).set('Authorization', A.auth);
    expect(list.body.data.items).toHaveLength(0);
    const edit = await request(app).patch(url).set('Authorization', A.auth).set('If-Match', 'W/"2"').send({ phone: '+2348044444444' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('PATIENT_INACTIVE');
    const on = await request(app).post(`${url}/reactivate`).set('Authorization', A.auth).set('If-Match', 'W/"2"').send({});
    expect(on.status).toBe(200);
    expect(on.body.data.status).toBe('ACTIVE');
  });

  it('finds likely duplicates by national ID or name + date of birth, within the tenant only', async () => {
    const hit = await request(app).get(`${base(A)}/patients/duplicates?nationalId=NIN-ALPHA-0001`).set('Authorization', A.auth);
    expect(hit.body.data.items.map((p) => p.id)).toEqual([patientA.id]);
    const other = await request(app).get(`${base(B)}/patients/duplicates?nationalId=NIN-ALPHA-0001`).set('Authorization', B.auth);
    expect(other.body.data.items).toHaveLength(0);
  });

  it('links a Sabi account only when that account is enrolled with this hospital, and only once', async () => {
    const account = await prisma.user.create({ data: { patientId: `SABI-P-${Date.now()}`, email: `patient-${Date.now()}@emr.test`, password: 'x', accountStatus: 'ACTIVE' } });
    const { body } = await register(A);
    const url = `${base(A)}/patients/${body.data.id}/link-account`;
    const refused = await request(app).post(url).set('Authorization', A.auth).set('If-Match', 'W/"1"').send({ userId: account.id });
    expect(refused.status).toBe(409);
    const plan = await prisma.hospitalMemberPlan.create({ data: { hospitalId: A.facilityId, name: 'Plan', description: 'Test', feeMinor: 0 } });
    await prisma.hospitalEnrollment.create({ data: { patientId: account.id, hospitalId: A.facilityId, planId: plan.id, status: 'ACTIVE' } });
    const linked = await request(app).post(url).set('Authorization', A.auth).set('If-Match', 'W/"1"').send({ userId: account.id });
    expect(linked.status).toBe(200);
    expect(linked.body.data.linkedUserId).toBe(account.id);
    const second = await register(A);
    const again = await request(app).post(`${base(A)}/patients/${second.body.data.id}/link-account`).set('Authorization', A.auth).set('If-Match', 'W/"1"').send({ userId: account.id });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PATIENT_ALREADY_LINKED');
  });

  it('rejects unknown fields such as a forged organizationId or version', async () => {
    const forged = await register(A, { ...newPatient(), organizationId: B.organizationId });
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe('VALIDATION_FAILED');
    const version = await request(app).patch(`${base(A)}/patients/${patientA.id}`).set('Authorization', A.auth).set('If-Match', 'W/"1"').send({ version: 99 });
    expect(version.status).toBe(400);
  });
});

describe('audit and events', () => {
  it('UC-3: an update writes an audit row (field names only) and an outbox event in the same transaction', async () => {
    const { body } = await register(A);
    await request(app).patch(`${base(A)}/patients/${body.data.id}`).set('Authorization', A.auth).set('If-Match', 'W/"1"').send({ phone: '+2348055555555', familyName: body.data.familyName });
    const audit = await prisma.emrAuditEvent.findFirst({ where: { resourceId: body.data.id, action: 'patient.updated' } });
    expect(audit.changedFields).toEqual(['phone']);
    expect(audit.actorUserId).toBe(A.userId);
    expect(audit.requestId).toBeTruthy();
    const event = await prisma.emrOutboxEvent.findFirst({ where: { aggregateId: body.data.id, eventType: 'patient.updated' } });
    expect(event.organizationId).toBe(A.organizationId);
    expect(JSON.stringify(event.payload)).not.toContain(body.data.familyName);
    expect(JSON.stringify(event.payload)).not.toContain('+2348055555555');
  });

  it('reads are audited and the audit trail is readable only with audit.view', async () => {
    await request(app).get(`${base(A)}/patients/${patientA.id}`).set('Authorization', A.auth);
    const trail = await request(app).get(`${base(A)}/audit-events?resourceType=patient&resourceId=${patientA.id}`).set('Authorization', A.auth);
    expect(trail.status).toBe(200);
    expect(trail.body.data.items.map((e) => e.action)).toContain('patient.viewed');
    const receptionist = await addMember(A, ['RECEPTIONIST']);
    expect((await request(app).get(`${base(A)}/audit-events`).set('Authorization', receptionist.auth)).status).toBe(403);
  });

  it('UC-14: audit rows cannot be changed or deleted — not by the app role, not even by the owner', async () => {
    await expect(withTenant({ organizationId: A.organizationId }, (tx) => tx.emrAuditEvent.updateMany({ data: { action: 'tampered' } }))).rejects.toThrow();
    await expect(withTenant({ organizationId: A.organizationId }, (tx) => tx.emrAuditEvent.deleteMany({}))).rejects.toThrow();
    await expect(prisma.emrAuditEvent.deleteMany({ where: { organizationId: A.organizationId } })).rejects.toThrow();
    expect(await prisma.emrAuditEvent.count({ where: { action: 'tampered' } })).toBe(0);
  });

  it('UC-15/UC-3: each tenant\'s webhook receives only its own events, signed; failures back off without blocking', async () => {
    await dispatchPending({ limit: 1000 }); // drain events from earlier tests (no subscribers then)
    const hookA = await request(app).post(`${base(A)}/webhooks`).set('Authorization', A.auth).send({ url: 'https://alpha.hooks.test/emr', eventTypes: ['patient.registered'] });
    const hookB = await request(app).post(`${base(B)}/webhooks`).set('Authorization', B.auth).send({ url: 'https://bravo.hooks.test/emr', eventTypes: ['*'] });
    expect(hookA.status).toBe(201);
    expect(hookA.body.data.secret).toMatch(/^whsec_/);
    const listed = await request(app).get(`${base(A)}/webhooks`).set('Authorization', A.auth);
    expect(JSON.stringify(listed.body)).not.toContain(hookA.body.data.secret);
    expect(JSON.stringify(listed.body)).not.toContain('secretCiphertext');

    const pa = (await register(A)).body.data;
    const pb = (await register(B)).body.data;
    await dispatchPending();

    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { status: url.includes('bravo') ? 500 : 204 }; };
    const result = await deliverDue({ fetchImpl });
    expect(result.claimed).toBe(2);

    const toA = calls.filter((c) => c.url.includes('alpha'));
    const toB = calls.filter((c) => c.url.includes('bravo'));
    expect(toA).toHaveLength(1);
    expect(toB).toHaveLength(1);
    const payloadA = JSON.parse(toA[0].init.body);
    expect(payloadA.organizationId).toBe(A.organizationId);
    expect(payloadA.aggregate.id).toBe(pa.id);
    expect(JSON.parse(toB[0].init.body).aggregate.id).toBe(pb.id);

    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(toA[0].init.headers['x-sabi-signature']);
    expect(v1).toBe(signPayload(hookA.body.data.secret, Number(t), toA[0].init.body));

    const failed = await prisma.emrWebhookDelivery.findFirst({ where: { subscriptionId: hookB.body.data.id } });
    expect(failed.status).toBe('PENDING');
    expect(failed.attempts).toBe(1);
    expect(failed.lastStatusCode).toBe(500);
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    const delivered = await prisma.emrWebhookDelivery.findFirst({ where: { subscriptionId: hookA.body.data.id } });
    expect(delivered.status).toBe('DELIVERED');

    const history = await request(app).get(`${base(B)}/webhooks/${hookA.body.data.id}/deliveries`).set('Authorization', B.auth);
    expect(history.status).toBe(404);

    // The first retry waits one base interval (30 s) — not two.
    const waitedMs = failed.nextAttemptAt.getTime() - Date.now();
    expect(waitedMs).toBeGreaterThan(20_000);
    expect(waitedMs).toBeLessThanOrEqual(30_000);

    // A subscriber that keeps failing is dead-lettered on its 10th attempt, not before.
    await prisma.emrWebhookDelivery.update({ where: { id: failed.id }, data: { attempts: MAX_ATTEMPTS - 2, nextAttemptAt: new Date(0) } });
    await deliverDue({ fetchImpl });
    const ninth = await prisma.emrWebhookDelivery.findUnique({ where: { id: failed.id } });
    expect(ninth.attempts).toBe(MAX_ATTEMPTS - 1);
    expect(ninth.status).toBe('PENDING');
    await prisma.emrWebhookDelivery.update({ where: { id: failed.id }, data: { nextAttemptAt: new Date(0) } });
    await deliverDue({ fetchImpl });
    const tenth = await prisma.emrWebhookDelivery.findUnique({ where: { id: failed.id } });
    expect(tenth.attempts).toBe(MAX_ATTEMPTS);
    expect(tenth.status).toBe('DEAD');
  });

  it('webhook URLs must be HTTPS without credentials', async () => {
    const response = await request(app).post(`${base(A)}/webhooks`).set('Authorization', A.auth).send({ url: 'https://user:pw@alpha.hooks.test/x', eventTypes: ['*'] });
    expect(response.status).toBe(400);
  });
});
