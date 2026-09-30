// Laboratory module against real Postgres with RLS on.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient, prisma } from './fixtures.js';

const year = new Date().getUTCFullYear();
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    put: (path, body, headers = {}) => request(app).put(url(path)).set('Authorization', who.auth).set(headers).send(body),
    patch: (path, body, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });

let A; let B; let doctor; let nurse; let scientist; let scientist2; let reception; let bScientist; let bDoctor;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });

async function openVisit(tenant = A, clinician = doctor, patientOverrides = {}) {
  const patient = (await as({ ...tenant }).post('/patients', newPatient({ sex: 'FEMALE', ...patientOverrides }))).body.data;
  const visit = (await as(clinician).post('/encounters', { patientId: patient.id })).body.data;
  await as(clinician).post(`/encounters/${visit.id}/start`, {}, ifMatch(1));
  return { patient, visit };
}
async function order(tests, { visit } = {}, who = doctor, tenant = A) {
  const target = visit ?? (await openVisit(tenant, who)).visit;
  const response = await as(who).post(`/encounters/${target.id}/lab-orders`, { tests, priority: 'STAT', clinicalNotes: 'Pale, tired' });
  expect(response.status).toBe(201);
  return response.body.data;
}
const item = (labOrder, code) => labOrder.items.find((i) => i.testCode === code);

beforeAll(async () => {
  A = await createTenant('labA');
  B = await createTenant('labB');
  A = { ...A, organizationId: A.organizationId };
  doctor = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  scientist = await member(A, ['LAB_SCIENTIST']);
  scientist2 = await member(A, ['LAB_SCIENTIST']);
  reception = await member(A, ['RECEPTIONIST']);
  bScientist = await member(B, ['LAB_SCIENTIST']);
  bDoctor = await member(B, ['DOCTOR']);
});

describe('test catalog', () => {
  it('each organization gets the starter catalog once, can extend it, and never sees another tenant\'s tests', async () => {
    const first = await as(scientist).get('/lab/tests');
    expect(first.status).toBe(200);
    const codes = first.body.data.items.map((t) => t.code);
    expect(codes).toEqual(expect.arrayContaining(['FBC', 'MP_RDT', 'FBS', 'EUCR', 'UA', 'PREG']));
    const sectionOf = Object.fromEntries(first.body.data.items.map((t) => [t.code, t.section]));
    expect(sectionOf).toMatchObject({ FBC: 'Haematology', MP_RDT: 'Parasitology', EUCR: 'Clinical Chemistry', UA: 'Urinalysis', PREG: 'Serology' });
    expect((await as(scientist).get('/lab/tests')).body.data.items).toHaveLength(codes.length);
    expect((await as(reception).get('/lab/tests')).status).toBe(403);

    const bad = await as(scientist).post('/lab/tests', { code: 'CRP', name: 'C-reactive protein', specimenType: 'Serum', analytes: [{ code: 'CRP', name: 'CRP', kind: 'NUMERIC', unit: 'mg/L', low: 10, high: 5 }] });
    expect(bad.status).toBe(400);
    const crp = await as(scientist).post('/lab/tests', { code: 'crp', name: 'C-reactive protein', specimenType: 'Serum', analytes: [{ code: 'CRP', name: 'CRP', kind: 'NUMERIC', unit: 'mg/L', high: 5 }] });
    expect(crp.status).toBe(201);
    expect(crp.body.data).toMatchObject({ code: 'CRP', section: 'General' });
    const moved = await as(scientist).patch('/lab/tests/CRP', { section: 'Clinical Chemistry' }, { 'If-Match': `W/"${crp.body.data.version}"` });
    expect(moved.body.data.section).toBe('Clinical Chemistry');
    expect((await as(scientist).post('/lab/tests', { code: 'CRP', name: 'Again', specimenType: 'Serum', analytes: [{ code: 'CRP', name: 'CRP', kind: 'TEXT' }] })).status).toBe(409);

    const inB = (await as(bScientist).get('/lab/tests')).body.data.items.map((t) => t.code);
    expect(inB).not.toContain('CRP');
    expect(inB).toContain('FBC');
  });
});

describe('order → collect → result → verify', () => {
  it('runs the whole workflow with server-computed flags, accession numbers and completion', async () => {
    const { visit } = await openVisit();
    const labOrder = await order(['FBC', 'MP_RDT'], { visit });
    expect(labOrder).toMatchObject({ status: 'ORDERED', priority: 'STAT', accessionNumber: null });
    expect(labOrder.items.map((i) => i.testCode).sort()).toEqual(['FBC', 'MP_RDT']);

    // Worklist: the lab sees the order with minimal patient identity only.
    const list = await as(scientist).get('/lab/orders?priority=STAT');
    const row = list.body.data.items.find((o) => o.id === labOrder.id);
    expect(row.patient).toEqual(expect.objectContaining({ medicalRecordNumber: expect.any(String), sex: 'FEMALE' }));
    expect(row.patient).not.toHaveProperty('phone');
    expect(row.patient).not.toHaveProperty('address');

    // Results before collection are refused; collection assigns the accession number.
    const fbc = item(labOrder, 'FBC');
    expect((await as(scientist).put(`/lab/orders/${labOrder.id}/items/${fbc.id}/results`, { results: [] }, ifMatch(1))).status).toBe(400);
    const early = await as(scientist).put(`/lab/orders/${labOrder.id}/items/${fbc.id}/results`, { results: [{ analyteCode: 'HB', value: 12 }, { analyteCode: 'PCV', value: 40 }, { analyteCode: 'WBC', value: 6 }, { analyteCode: 'PLT', value: 200 }] }, ifMatch(1));
    expect(early.status).toBe(409);
    const collected = await as(nurse).post(`/lab/orders/${labOrder.id}/collect`, { note: 'Left antecubital' }, ifMatch(1));
    expect(collected.status).toBe(200);
    expect(collected.body.data.accessionNumber).toMatch(new RegExp(`^LAB-${year}-\\d{6}$`));

    // Only lab scientists enter results; every analyte is required.
    const fbcUrl = `/lab/orders/${labOrder.id}/items/${fbc.id}`;
    expect((await as(doctor).put(`${fbcUrl}/results`, { results: [{ analyteCode: 'HB', value: 12 }] }, ifMatch(1))).status).toBe(403);
    const partial = await as(scientist).put(`${fbcUrl}/results`, { results: [{ analyteCode: 'HB', value: 12 }] }, ifMatch(1));
    expect(partial.status).toBe(400);
    expect(partial.body.error.details.map((d) => d.field).sort()).toEqual(['PCV', 'PLT', 'WBC']);

    const entered = await as(scientist).put(`${fbcUrl}/results`, { results: [
      { analyteCode: 'HB', value: 6.5 }, { analyteCode: 'PCV', value: 30 }, { analyteCode: 'WBC', value: 7.2 }, { analyteCode: 'PLT', value: 250 },
    ] }, ifMatch(1));
    expect(entered.status).toBe(200);
    const flags = Object.fromEntries(entered.body.data.results.map((r) => [r.analyteCode, r.flag]));
    expect(flags).toEqual({ HB: 'CRITICAL_LOW', PCV: 'LOW', WBC: 'NORMAL', PLT: 'NORMAL' });
    const hb = entered.body.data.results.find((r) => r.analyteCode === 'HB');
    expect(hb).toMatchObject({ valueNumeric: 6.5, unit: 'g/dL', referenceLow: 12, referenceHigh: 15.5, status: 'PRELIMINARY' }); // female range

    // Re-entry before verification replaces the preliminary values.
    const again = await as(scientist).put(`${fbcUrl}/results`, { results: [
      { analyteCode: 'HB', value: 6.8 }, { analyteCode: 'PCV', value: 30 }, { analyteCode: 'WBC', value: 7.2 }, { analyteCode: 'PLT', value: 250 },
    ] }, ifMatch(2));
    expect(again.body.data.results).toHaveLength(4);
    expect(again.body.data.results.find((r) => r.analyteCode === 'HB').valueNumeric).toBe(6.8);

    const verified = await as(scientist2).post(`${fbcUrl}/verify`, {}, ifMatch(3));
    expect(verified.status).toBe(200);
    expect(verified.body.data).toMatchObject({ status: 'VERIFIED', verifiedByUserId: scientist2.userId, orderCompleted: false });
    expect(verified.body.data.results.every((r) => r.status === 'FINAL')).toBe(true);

    const mp = item(labOrder, 'MP_RDT');
    const mpUrl = `/lab/orders/${labOrder.id}/items/${mp.id}`;
    const positive = await as(scientist).put(`${mpUrl}/results`, { results: [{ analyteCode: 'MP', value: 'positive' }] }, ifMatch(1));
    expect(positive.body.data.results[0]).toMatchObject({ valueText: 'POSITIVE', flag: 'ABNORMAL' });
    expect((await as(scientist).put(`${mpUrl}/results`, { results: [{ analyteCode: 'MP', value: 'maybe' }] }, ifMatch(2))).status).toBe(400);
    const done = await as(scientist).post(`${mpUrl}/verify`, {}, ifMatch(2));
    expect(done.body.data.orderCompleted).toBe(true);

    // The doctor sees released results in the visit.
    const inVisit = await as(doctor).get(`/encounters/${visit.id}/lab-orders`);
    const seen = inVisit.body.data.items.find((o) => o.id === labOrder.id);
    expect(seen.status).toBe('COMPLETED');
    expect(item(seen, 'FBC').results.find((r) => r.analyteCode === 'HB')).toMatchObject({ valueNumeric: 6.8, flag: 'CRITICAL_LOW', status: 'FINAL' });

    // Events: released for both tests, a critical alert for the FBC only — identifiers, no values.
    const events = await prisma.emrOutboxEvent.findMany({ where: { aggregateId: labOrder.id }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.eventType)).toEqual(['lab.ordered', 'lab.result.released', 'lab.result.critical', 'lab.result.released']);
    expect(events.find((e) => e.eventType === 'lab.result.critical').payload.data).toMatchObject({ itemId: fbc.id, criticalCount: 1 });
    expect(JSON.stringify(events)).not.toMatch(/6\.8|POSITIVE|Haemoglobin|Pale/);
  });

  it('released values are locked; a correction supersedes them and keeps the history', async () => {
    const labOrder = await order(['FBS']);
    const fbs = item(labOrder, 'FBS');
    const url = `/lab/orders/${labOrder.id}/items/${fbs.id}`;
    await as(nurse).post(`/lab/orders/${labOrder.id}/collect`, {}, ifMatch(1));
    await as(scientist).put(`${url}/results`, { results: [{ analyteCode: 'GLU', value: 30 }] }, ifMatch(1));
    await as(scientist).post(`${url}/verify`, {}, ifMatch(2));

    expect((await as(scientist).put(`${url}/results`, { results: [{ analyteCode: 'GLU', value: 5 }] }, ifMatch(3))).status).toBe(409);
    await expect(withTenant({ organizationId: A.organizationId }, (tx) => tx.emrLabResult.updateMany({ where: { itemId: fbs.id }, data: { valueNumeric: 5 } }))).rejects.toThrow();
    await expect(withTenant({ organizationId: A.organizationId }, (tx) => tx.emrLabResult.deleteMany({ where: { itemId: fbs.id } }))).rejects.toThrow();

    expect((await as(doctor).post(`${url}/amend`, { reason: 'Doctor tries to change it', results: [{ analyteCode: 'GLU', value: 5 }] }, ifMatch(3))).status).toBe(403);
    const amended = await as(scientist).post(`${url}/amend`, { reason: 'Transcription error: 3.0 entered as 30', results: [{ analyteCode: 'GLU', value: 3.0 }] }, ifMatch(3));
    expect(amended.status).toBe(200);
    expect(amended.body.data.results).toEqual([expect.objectContaining({ valueNumeric: 3, flag: 'LOW', status: 'FINAL', amendmentReason: 'Transcription error: 3.0 entered as 30' })]);

    const history = (await as(scientist).get(`/lab/orders/${labOrder.id}`)).body.data;
    const glucose = item(history, 'FBS').results;
    expect(glucose.map((r) => [r.valueNumeric, r.status])).toEqual([[30, 'SUPERSEDED'], [3, 'FINAL']]);
    expect(glucose[0]).toMatchObject({ flag: 'CRITICAL_HIGH', supersededByUserId: scientist.userId });
    const types = (await prisma.emrOutboxEvent.findMany({ where: { aggregateId: labOrder.id } })).map((e) => e.eventType);
    expect(types).toContain('lab.result.amended');
  });

  it('orders can be cancelled only before results; closed visits take no new orders', async () => {
    const { visit } = await openVisit();
    const labOrder = await order(['RBS'], { visit });
    expect((await as(doctor).post(`/lab/orders/${labOrder.id}/cancel`, {}, ifMatch(1))).status).toBe(400);
    const cancelled = await as(doctor).post(`/lab/orders/${labOrder.id}/cancel`, { reason: 'Ordered in error' }, ifMatch(1));
    expect(cancelled.body.data.status).toBe('CANCELLED');
    expect((await as(nurse).post(`/lab/orders/${labOrder.id}/collect`, {}, ifMatch(2))).status).toBe(409);

    const resulted = await order(['RBS'], { visit });
    await as(nurse).post(`/lab/orders/${resulted.id}/collect`, {}, ifMatch(1));
    await as(scientist).put(`/lab/orders/${resulted.id}/items/${item(resulted, 'RBS').id}/results`, { results: [{ analyteCode: 'GLU', value: 6 }] }, ifMatch(1));
    expect((await as(doctor).post(`/lab/orders/${resulted.id}/cancel`, { reason: 'Too late' }, ifMatch(3))).status).toBe(409);

    await as(doctor).post(`/encounters/${visit.id}/finish`, {}, ifMatch(2));
    expect((await as(doctor).post(`/encounters/${visit.id}/lab-orders`, { tests: ['RBS'] })).status).toBe(409);
    expect((await as(doctor).post(`/encounters/${visit.id}/lab-orders`, { tests: ['NOPE'] })).status).toBe(409);
  });

  it('unknown tests are refused and later catalog edits never change an existing order', async () => {
    const { visit } = await openVisit();
    expect((await as(doctor).post(`/encounters/${visit.id}/lab-orders`, { tests: ['NOPE'] })).status).toBe(400);
    const labOrder = await order(['LIPID'], { visit });
    const tests = (await as(scientist).get('/lab/tests')).body.data.items;
    const lipid = tests.find((t) => t.code === 'LIPID');
    const edited = await as(scientist).patch('/lab/tests/LIPID', { analytes: [{ code: 'CHOL', name: 'Total cholesterol', kind: 'NUMERIC', unit: 'mmol/L', high: 6 }] }, ifMatch(lipid.version));
    expect(edited.status).toBe(200);
    const stored = await prisma.emrLabOrderItem.findUnique({ where: { id: item(labOrder, 'LIPID').id } });
    expect(stored.analytes).toHaveLength(4);
    expect(stored.analytes.find((a) => a.code === 'CHOL').high).toBe(5.2);
  });
});

describe('tenant isolation for the lab', () => {
  it('another organization cannot see or act on an order; accession numbers are per organization', async () => {
    const labOrder = await order(['HBSAG']);
    expect((await as(bScientist).get(`/lab/orders/${labOrder.id}`)).status).toBe(404);
    expect((await as(bScientist).post(`/lab/orders/${labOrder.id}/collect`, {}, ifMatch(1))).status).toBe(404);
    const itemUrl = `/lab/orders/${labOrder.id}/items/${item(labOrder, 'HBSAG').id}/results`;
    expect((await as(bScientist).put(itemUrl, { results: [{ analyteCode: 'HBSAG', value: 'REACTIVE' }] }, ifMatch(1))).status).toBe(404);
    expect((await as(bScientist).get('/lab/orders')).body.data.items.map((o) => o.id)).not.toContain(labOrder.id);

    const bOrder = await order(['HIV_RDT'], {}, bDoctor, B);
    const bCollected = await as(bScientist).post(`/lab/orders/${bOrder.id}/collect`, {}, ifMatch(1));
    expect(bCollected.body.data.accessionNumber).toBe(`LAB-${year}-000001`);
  });

  it('simultaneous collections in one organization get distinct, consecutive accession numbers', async () => {
    const orders = await Promise.all([order(['UA']), order(['UA']), order(['UA'])]);
    const collected = await Promise.all(orders.map((o) => as(nurse).post(`/lab/orders/${o.id}/collect`, {}, ifMatch(1))));
    const numbers = collected.map((r) => r.body.data.accessionNumber);
    expect(new Set(numbers).size).toBe(3);
    const seq = numbers.map((n) => Number(n.slice(-6))).sort((a, b) => a - b);
    expect(seq[2] - seq[0]).toBe(2);
  });
});

describe('result follow-up', () => {
  const hbLow = [{ analyteCode: 'HB', value: 6.5 }, { analyteCode: 'PCV', value: 30 }, { analyteCode: 'WBC', value: 7.2 }, { analyteCode: 'PLT', value: 250 }];
  async function resultedFbc() {
    const labOrder = await order(['FBC']);
    await as(nurse).post(`/lab/orders/${labOrder.id}/collect`, {}, ifMatch(1));
    const fbc = item(labOrder, 'FBC');
    const url = `/lab/orders/${labOrder.id}/items/${fbc.id}`;
    expect((await as(scientist).put(`${url}/results`, { results: hbLow }, ifMatch(1))).status).toBe(200);
    return { labOrder, url };
  }

  it('a verifier sends a result back with a reason; it is re-entered and then released', async () => {
    const { url } = await resultedFbc();
    expect((await as(scientist2).post(`${url}/return`, { reason: 'x' }, ifMatch(2))).status).toBe(400);
    const returned = await as(scientist2).post(`${url}/return`, { reason: 'PCV inconsistent with Hb — recheck' }, ifMatch(2));
    expect(returned.body.data).toMatchObject({ status: 'PENDING', returnReason: 'PCV inconsistent with Hb — recheck', returnedByUserId: scientist2.userId });
    expect((await as(scientist2).post(`${url}/verify`, {}, ifMatch(3))).status).toBe(409); // nothing to verify until re-entered
    expect((await as(scientist2).post(`${url}/return`, { reason: 'Again please' }, ifMatch(3))).status).toBe(409);
    expect((await as(scientist).put(`${url}/results`, { results: hbLow }, ifMatch(3))).body.data.status).toBe('RESULTED');
    expect((await as(scientist2).post(`${url}/verify`, {}, ifMatch(4))).body.data.status).toBe('VERIFIED');
    expect((await as(doctor).post(`${url}/return`, { reason: 'Doctors cannot do this' }, ifMatch(5))).status).toBe(403);
  });

  it('records who was told about an abnormal result and who acknowledged it; an amendment asks again', async () => {
    const { url } = await resultedFbc();
    expect((await as(doctor).post(`${url}/acknowledge`, {}, ifMatch(2))).status).toBe(409); // not released yet
    await as(scientist2).post(`${url}/verify`, {}, ifMatch(2));

    expect((await as(scientist).post(`${url}/communicate`, { toUserId: nurse.userId }, ifMatch(3))).status).toBe(400); // nurses do not order tests
    const told = await as(scientist).post(`${url}/communicate`, { toUserId: doctor.userId }, ifMatch(3));
    expect(told.body.data).toMatchObject({ criticalCommunicatedByUserId: scientist.userId, criticalCommunicatedToUserId: doctor.userId });
    expect((await as(scientist).post(`${url}/communicate`, { toUserId: doctor.userId }, ifMatch(4))).status).toBe(409);

    expect((await as(scientist).post(`${url}/acknowledge`, {}, ifMatch(4))).status).toBe(403);
    const seen = await as(doctor).post(`${url}/acknowledge`, {}, ifMatch(4));
    expect(seen.body.data).toMatchObject({ acknowledgedByUserId: doctor.userId });
    expect((await as(doctor).post(`${url}/acknowledge`, {}, ifMatch(5))).status).toBe(409);

    const amended = await as(scientist2).post(`${url}/amend`, { reason: 'Transcription error', results: hbLow.map((r) => (r.analyteCode === 'HB' ? { ...r, value: 7.1 } : r)) }, ifMatch(5));
    expect(amended.body.data).toMatchObject({ acknowledgedAt: null, criticalCommunicatedAt: null });
  });

  it('only abnormal released results are communicated, and the database keeps who/when together', async () => {
    const labOrder = await order(['MP_RDT']);
    await as(nurse).post(`/lab/orders/${labOrder.id}/collect`, {}, ifMatch(1));
    const url = `/lab/orders/${labOrder.id}/items/${item(labOrder, 'MP_RDT').id}`;
    await as(scientist).put(`${url}/results`, { results: [{ analyteCode: 'MP', value: 'NEGATIVE' }] }, ifMatch(1));
    await as(scientist2).post(`${url}/verify`, {}, ifMatch(2));
    expect((await as(scientist).post(`${url}/communicate`, { toUserId: doctor.userId }, ifMatch(3))).status).toBe(409);
    await expect(withTenant({ organizationId: A.organizationId, userId: doctor.userId }, (tx) => tx.emrLabOrderItem.updateMany({
      where: { organizationId: A.organizationId, id: item(labOrder, 'MP_RDT').id }, data: { acknowledgedAt: new Date() },
    }))).rejects.toThrow();
  });

  it('the worklist carries current results and staff names, newest first when asked', async () => {
    const { labOrder } = await resultedFbc();
    const newest = (await as(scientist).get('/lab/orders?status=ORDERED,COLLECTED,IN_PROGRESS&sort=newest&limit=5')).body.data.items;
    expect(newest[0].id).toBe(labOrder.id);
    const names = async (who) => (await prisma.user.findUnique({ where: { id: who.userId }, select: { full_name: true } })).full_name;
    expect(newest[0]).toMatchObject({ orderedByName: await names(doctor), collectedByName: await names(nurse) });
    expect(newest[0].items[0]).toMatchObject({ status: 'RESULTED', resultedByName: await names(scientist) });
    expect(newest[0].items[0].results.map((r) => r.analyteCode).sort()).toEqual(['HB', 'PCV', 'PLT', 'WBC']);
    const oldest = (await as(scientist).get('/lab/orders?status=ORDERED,COLLECTED,IN_PROGRESS&limit=100')).body.data.items;
    expect(oldest.at(-1).id).toBe(labOrder.id);
  });

  it('lists colleagues by capability (names only) for pickers', async () => {
    const clinicians = (await as(scientist).get('/staff?permission=lab.order.create')).body.data.items;
    expect(clinicians.map((c) => c.userId)).toContain(doctor.userId);
    expect(clinicians.map((c) => c.userId)).not.toContain(nurse.userId);
    expect(Object.keys(clinicians[0]).sort()).toEqual(['name', 'userId']);
    expect((await as(scientist).get('/staff?permission=membership.manage')).status).toBe(400);
    expect((await as(bScientist).get('/staff?permission=lab.order.create')).body.data.items.map((c) => c.userId)).not.toContain(doctor.userId);
  });
});
