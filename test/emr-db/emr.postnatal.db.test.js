// Postnatal care against real Postgres with RLS on: days postpartum and contact from the delivery,
// the contacts-due list, danger-sign escalation to an urgent Consultation visit, corrections,
// permissions and isolation.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient } from './fixtures.js';

const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const daysAgoIso = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const dayOf = (iso) => iso.slice(0, 10);
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let nurse; let desk; let admin; let bNurse;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const woman = async () => (await as(A).post('/patients', newPatient({ sex: 'FEMALE' }))).body.data;
async function delivered(daysAgo) {
  const mother = await woman();
  const delivery = (await as(nurse).post('/deliveries', {
    patientId: mother.id, bookingStatus: 'UNBOOKED', deliveredAt: daysAgoIso(daysAgo), gestationalWeeks: 39, mode: 'SVD', motherStatus: 'ALIVE', bloodLossMl: 250,
    babySex: 'MALE', babyStatus: 'ALIVE', birthWeightKg: 3.3, apgar1: 8, apgar5: 9, conductedByUserId: nurse.userId,
  }, key())).body.data;
  return { mother, delivery };
}
const visit = (patientId, extra = {}) => ({ patientId, visitDate: dayOf(new Date().toISOString()), uterus: 'WELL_CONTRACTED', lochia: 'NORMAL', breast: 'NORMAL', breastfeeding: 'EXCLUSIVE', ...extra });

beforeAll(async () => {
  A = await createTenant('pncA');
  B = await createTenant('pncB');
  nurse = await member(A, ['NURSE']);
  desk = await member(A, ['RECEPTIONIST']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  bNurse = await member(B, ['NURSE']);
});

describe('postnatal care', () => {
  it('works out days postpartum and the WHO contact from the delivery, and tracks contacts due', async () => {
    const { mother, delivery } = await delivered(5);
    let due = (await as(nurse).get('/postnatal/due')).body.data.items.find((row) => row.deliveryId === delivery.id);
    expect(due).toMatchObject({ daysPostpartum: 5, nextContact: 1, status: 'OVERDUE', overdueDays: 4 });

    const recorded = await as(nurse).post('/postnatal', visit(mother.id, { deliveryId: delivery.id, daysPostpartum: 40, systolic: 118, diastolic: 74, fpCounselled: true }), key());
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect(recorded.body.data).toMatchObject({ daysPostpartum: 5, contact: 2, escalatedEncounterId: null, recordedByName: expect.any(String) });
    due = (await as(nurse).get('/postnatal/due')).body.data.items.find((row) => row.deliveryId === delivery.id);
    expect(due.nextContact).toBe(1); // contact 1 (first 24 h) is still not done

    // Without a delivery here, days postpartum must be given.
    const other = await woman();
    expect((await as(nurse).post('/postnatal', visit(other.id), key())).status).toBe(400);
    expect((await as(nurse).post('/postnatal', visit(other.id, { daysPostpartum: 42 }), key())).body.data.contact).toBe(4);
    expect((await as(nurse).post('/postnatal', visit(other.id, { deliveryId: delivery.id }), key())).status).toBe(400); // not her delivery
  });

  it('sends the mother to Consultation as urgent when danger signs are found, once', async () => {
    const { mother, delivery } = await delivered(2);
    const signs = ['Jaundice', 'Fever (>37.5°)'];
    const first = await as(nurse).post('/postnatal', visit(mother.id, { deliveryId: delivery.id, dangerSigns: signs }), key());
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const encounterId = first.body.data.escalatedEncounterId;
    expect(encounterId).toEqual(expect.any(String));
    const queue = (await as(nurse).get('/queue?station=Consultation')).body.data.items.find((entry) => entry.encounterId === encounterId);
    expect(queue).toMatchObject({ priority: 'URGENT', complaint: expect.stringContaining('Jaundice') });
    // A second danger visit while that visit is open reuses it.
    const second = await as(nurse).post('/postnatal', visit(mother.id, { deliveryId: delivery.id, dangerSigns: ['Convulsions'] }), key());
    expect(second.body.data.escalatedEncounterId).toBe(encounterId);
    expect((await as(nurse).post('/postnatal', visit(mother.id, { dangerSigns: ['Made up'] }), key())).status).toBe(400);
  });

  it('corrects by entered-in-error, and keeps the desk and other hospitals out', async () => {
    const { mother, delivery } = await delivered(10);
    const row = (await as(nurse).post('/postnatal', visit(mother.id, { deliveryId: delivery.id }), key())).body.data;
    const marked = await as(nurse).post(`/postnatal/${row.id}/entered-in-error`, { reason: 'Wrong mother selected' });
    expect(marked.body.data).toMatchObject({ status: 'ENTERED_IN_ERROR', erroredByName: expect.any(String) });
    expect((await as(desk).get('/postnatal')).status).toBe(403);
    expect((await as(admin).post('/postnatal', visit(mother.id, { deliveryId: delivery.id }), key())).status).toBe(403);
    expect((await as(admin).get('/postnatal')).status).toBe(200);
    expect((await as(bNurse).get('/postnatal')).body.data.items.find((v) => v.id === row.id)).toBeUndefined();
    const ctx = { organizationId: A.organizationId, userId: nurse.userId };
    await expect(withTenant(ctx, (tx) => tx.emrPncVisit.updateMany({ where: { id: row.id }, data: { contact: 1 } }))).rejects.toThrow();
  });
});
