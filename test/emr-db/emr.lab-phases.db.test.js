// Lab test settings against real Postgres with RLS on: a test's turnaround and bench phases are set in
// the catalog and snapshotted onto orders; phases complete in order with who and when; results wait for
// every phase before the last, and entering them completes the last.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient } from './fixtures.js';

const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    put: (path, body = {}, headers = {}) => request(app).put(url(path)).set('Authorization', who.auth).set(headers).send(body),
    patch: (path, body = {}, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let doctor; let nurse; let scientist;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });

beforeAll(async () => {
  A = await createTenant('phA');
  doctor = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  scientist = await member(A, ['LAB_SCIENTIST']);
});

const orderMp = async () => {
  const patient = (await as(A).post('/patients', newPatient())).body.data;
  const visit = (await as(doctor).post('/encounters', { patientId: patient.id })).body.data;
  await as(doctor).post(`/encounters/${visit.id}/start`, {}, ifMatch(1));
  const order = (await as(doctor).post(`/encounters/${visit.id}/lab-orders`, { tests: ['MP_RDT'] })).body.data;
  await as(nurse).post(`/lab/orders/${order.id}/collect`, {}, ifMatch(1));
  return { order, item: order.items[0] };
};

describe('lab test settings and bench phases', () => {
  it('sets turnaround and phases in the catalog, and walks an order through them', async () => {
    const tests = (await as(scientist).get('/lab/tests')).body.data;
    const mp = (tests.items ?? tests).find((t) => t.code === 'MP_RDT');
    expect(mp).toMatchObject({ turnaroundMinutes: 60, phases: [] });
    expect((await as(scientist).patch('/lab/tests/MP_RDT', { phases: ['Prep', 'prep'] }, ifMatch(mp.version))).status).toBe(400);
    expect((await as(scientist).patch('/lab/tests/MP_RDT', { turnaroundMinutes: 2 }, ifMatch(mp.version))).status).toBe(400);
    const set = await as(scientist).patch('/lab/tests/MP_RDT', { turnaroundMinutes: 30, phases: ['Sample preparation', 'Read cassette'] }, ifMatch(mp.version));
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data).toMatchObject({ turnaroundMinutes: 30, phases: ['Sample preparation', 'Read cassette'] });

    const { order, item } = await orderMp();
    expect(item).toMatchObject({ turnaroundMinutes: 30, phases: ['Sample preparation', 'Read cassette'], phaseIndex: 0 });
    const url = `/lab/orders/${order.id}/items/${item.id}`;
    expect((await as(scientist).put(`${url}/results`, { results: [{ analyteCode: 'MP', value: 'positive' }] }, ifMatch(1))).body.error.message).toMatch(/Sample preparation/);
    expect((await as(scientist).post(`${url}/phase`, { phase: 'Read cassette' }, ifMatch(1))).status).toBe(409);
    expect((await as(doctor).post(`${url}/phase`, { phase: 'Sample preparation' }, ifMatch(1))).status).toBe(403);
    const step = await as(scientist).post(`${url}/phase`, { phase: 'sample preparation' }, ifMatch(1));
    expect(step.body.data).toMatchObject({ phaseIndex: 1, phaseLog: [expect.objectContaining({ position: 0, phase: 'Sample preparation' })] });
    expect((await as(scientist).post(`${url}/phase`, { phase: 'Read cassette' }, ifMatch(2))).body.error.message).toMatch(/entering the results/);
    const resulted = await as(scientist).put(`${url}/results`, { results: [{ analyteCode: 'MP', value: 'positive' }] }, ifMatch(2));
    expect(resulted.status, JSON.stringify(resulted.body)).toBe(200);

    const worklist = (await as(scientist).get('/lab/orders?status=IN_PROGRESS,COLLECTED&limit=50')).body.data.items;
    const listed = worklist.find((o) => o.id === order.id).items[0];
    expect(listed).toMatchObject({ phaseIndex: 2, phaseLog: [expect.objectContaining({ phase: 'Sample preparation', completedByName: expect.any(String) }), expect.objectContaining({ phase: 'Read cassette', position: 1 })] });
    // The log is insert-only.
    const ctx = { organizationId: A.organizationId, userId: scientist.userId };
    await expect(withTenant(ctx, (tx) => tx.emrLabItemPhase.updateMany({ where: { itemId: item.id }, data: { phase: 'x' } }))).rejects.toThrow();
  });

  it('keeps tests without phases going straight from collection to results', async () => {
    const tests = (await as(scientist).get('/lab/tests')).body.data;
    const mp = (tests.items ?? tests).find((t) => t.code === 'MP_RDT');
    await as(scientist).patch('/lab/tests/MP_RDT', { phases: [] }, ifMatch(mp.version));
    const { order, item } = await orderMp();
    expect((await as(scientist).put(`/lab/orders/${order.id}/items/${item.id}/results`, { results: [{ analyteCode: 'MP', value: 'negative' }] }, ifMatch(1))).status).toBe(200);
    expect((await as(scientist).post(`/lab/orders/${order.id}/items/${item.id}/phase`, { phase: 'Anything' }, ifMatch(2))).status).toBe(409);
  });
});
