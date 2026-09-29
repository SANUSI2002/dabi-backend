// Prescribing, pharmacy stock and dispensing against real Postgres with RLS on.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { addMember, createTenant, newPatient, prisma } from './fixtures.js';

const year = new Date().getUTCFullYear();
const EARLY = `${year + 1}-01-31`;
const LATE = `${year + 2}-06-30`;
const key = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    patch: (path, body, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let B; let doctor; let doctor2; let nurse; let pharmacist; let pharmacist2; let reception; let bPharmacist;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });

async function openVisit() {
  const patient = (await as(A).post('/patients', newPatient())).body.data;
  const visit = (await as(doctor).post('/encounters', { patientId: patient.id })).body.data;
  await as(doctor).post(`/encounters/${visit.id}/start`, {}, ifMatch(1));
  return { patient, visit };
}
async function receive(drugCode, quantity, { batchNumber = `B-${randomUUID().slice(0, 6)}`, expiryDate = LATE, who = pharmacist } = {}) {
  const response = await as(who).post('/pharmacy/stock/receipts', { formularyCode: drugCode, batchNumber, expiryDate, quantity }, key());
  expect(response.status).toBe(201);
  return response.body.data;
}
async function prescribe(visit, items, extra = {}) {
  return as(doctor).post(`/encounters/${visit.id}/prescriptions`, { items, ...extra });
}
async function approved(visit, items, extra) {
  const created = await prescribe(visit, items, extra);
  expect(created.status).toBe(201);
  const response = await as(pharmacist).post(`/pharmacy/prescriptions/${created.body.data.id}/approve`, { note: 'Checked' }, ifMatch(1));
  expect(response.status).toBe(200);
  return response.body.data;
}
const onHand = async (drugCode) => (await as(pharmacist).get(`/pharmacy/stock?q=${drugCode}`)).body.data.items.find((i) => i.code === drugCode).onHand;
const balanced = async (who = pharmacist) => (await as(who).get('/pharmacy/stock/reconciliation')).body.data;
const para = (dose = 1000, extra = {}) => ({ drugCode: 'PARA500', dose, doseUnit: 'mg', frequency: 'TDS', durationDays: 5, ...extra });

beforeAll(async () => {
  A = await createTenant('rxA');
  B = await createTenant('rxB');
  doctor = await member(A, ['DOCTOR']);
  doctor2 = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  pharmacist = await member(A, ['PHARMACIST']);
  pharmacist2 = await member(A, ['PHARMACIST']);
  reception = await member(A, ['RECEPTIONIST']);
  bPharmacist = await member(B, ['PHARMACIST']);
});

describe('formulary and stock', () => {
  it('provisions the starter formulary once, and lets pharmacy extend it', async () => {
    const list = await as(doctor).get('/pharmacy/formulary');
    expect(list.status).toBe(200);
    const codes = list.body.data.items.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['PARA500', 'AMOX500', 'AL20_120', 'TRAM50', 'MORPH10_INJ']));
    expect(list.body.data.items.find((i) => i.code === 'TRAM50')).toMatchObject({ controlled: true, drugClasses: ['OPIOID'], inStock: 0 });
    expect((await as(reception).get('/pharmacy/formulary')).status).toBe(403);
    const created = await as(pharmacist).post('/pharmacy/formulary', {
      code: 'cotrim480', genericName: 'Co-trimoxazole', form: 'Tablet', strength: '480 mg', doseUnit: 'mg', dispenseUnit: 'tablet',
      dosePerDispenseUnit: 480, maxDailyDose: 1920, defaultRoute: 'PO', drugClasses: ['SULFONAMIDE'],
    });
    expect(created.status).toBe(201);
    expect(created.body.data.code).toBe('COTRIM480');
    expect((await as(pharmacist).post('/pharmacy/formulary', { code: 'COTRIM480', genericName: 'x', form: 'x', strength: 'x', doseUnit: 'mg', dispenseUnit: 'x', defaultRoute: 'PO' })).status).toBe(409);
    expect((await as(pharmacist).post('/pharmacy/formulary', { code: 'BAD', genericName: 'x', form: 'x', strength: 'x', doseUnit: 'mg', dispenseUnit: 'x', defaultRoute: 'ORAL' })).status).toBe(400);
    expect((await as(bPharmacist).get('/pharmacy/formulary')).body.data.items.map((i) => i.code)).not.toContain('COTRIM480');
  });

  it('receipts need an Idempotency-Key, replay safely, top up the same batch, and refuse expired stock', async () => {
    const body = { formularyCode: 'OMEP20', batchNumber: 'OM-001', expiryDate: LATE, quantity: 100 };
    const missing = await as(pharmacist).post('/pharmacy/stock/receipts', body);
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const headers = key();
    const first = await as(pharmacist).post('/pharmacy/stock/receipts', body, headers);
    const replay = await as(pharmacist).post('/pharmacy/stock/receipts', body, headers);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await onHand('OMEP20')).toBe(100);
    const topUp = await as(pharmacist).post('/pharmacy/stock/receipts', { ...body, quantity: 50 }, key());
    expect(topUp.body.data).toMatchObject({ id: first.body.data.id, quantityOnHand: 150 });
    expect((await as(pharmacist).post('/pharmacy/stock/receipts', { ...body, expiryDate: `${year - 1}-01-01` }, key())).status).toBe(400);
    expect((await as(doctor).post('/pharmacy/stock/receipts', body, key())).status).toBe(403);
    const ledger = (await as(pharmacist).get('/pharmacy/stock/movements?formularyCode=OMEP20')).body.data.items;
    expect(ledger.map((m) => [m.kind, m.quantity, m.balanceAfter])).toEqual([['RECEIPT', 50, 150], ['RECEIPT', 100, 100]]);
    expect((await balanced()).balanced).toBe(true);
  });

  it('adjustments are versioned, explained, never negative, and signal low stock once', async () => {
    const batch = await receive('METF500', 60);
    await as(pharmacist).patch('/pharmacy/formulary/METF500', { reorderLevel: 40 }, ifMatch(1));
    const tooMuch = await as(pharmacist).post(`/pharmacy/stock/batches/${batch.id}/adjust`, { quantity: -61, reason: 'LOST' }, ifMatch(batch.version));
    expect(tooMuch.status).toBe(409);
    expect((await as(pharmacist).post(`/pharmacy/stock/batches/${batch.id}/adjust`, { quantity: -5, reason: 'OTHER' }, ifMatch(batch.version))).status).toBe(400);
    const damaged = await as(pharmacist).post(`/pharmacy/stock/batches/${batch.id}/adjust`, { quantity: -25, reason: 'DAMAGED', note: 'Water damage' }, ifMatch(batch.version));
    expect(damaged.body.data.quantityOnHand).toBe(35);
    expect((await as(pharmacist).post(`/pharmacy/stock/batches/${batch.id}/adjust`, { quantity: -1, reason: 'LOST' }, ifMatch(batch.version))).status).toBe(412);
    const low = await prisma.emrOutboxEvent.findMany({ where: { organizationId: A.organizationId, eventType: 'stock.low' } });
    expect(low.filter((e) => e.payload.data.code === 'METF500')).toHaveLength(1);
    const movement = (await as(pharmacist).get(`/pharmacy/stock/movements?batchId=${batch.id}`)).body.data.items[0];
    expect(movement).toMatchObject({ kind: 'ADJUSTMENT', quantity: -25, balanceAfter: 35, reason: 'DAMAGED: Water damage' });
  });
});

describe('prescribing safety checks', () => {
  it('blocks an allergy match (by drug class) until the prescriber records an override', async () => {
    const { patient, visit } = await openVisit();
    const allergy = await as(nurse).post(`/patients/${patient.id}/allergies`, { substance: 'Penicillin', substanceCode: 'PENICILLIN', reaction: 'Urticaria', severity: 'SEVERE' });
    expect(allergy.status).toBe(201);
    expect((await as(nurse).post(`/patients/${patient.id}/allergies`, { substance: 'Penicillins', substanceCode: 'penicillin' })).status).toBe(409);

    const amox = { drugCode: 'AMOX500', dose: 500, doseUnit: 'mg', frequency: 'TDS', durationDays: 5 };
    const blocked = await prescribe(visit, [amox]);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('SAFETY_CHECK_REQUIRED');
    expect(blocked.body.error.details).toEqual([expect.objectContaining({ drugCode: 'AMOX500', type: 'ALLERGY', severity: 'HIGH' })]);

    const overridden = await prescribe(visit, [amox], { overrides: [{ drugCode: 'AMOX500', type: 'ALLERGY', reason: 'Tolerated amoxicillin in 2025 under observation' }] });
    expect(overridden.status).toBe(201);
    expect(overridden.body.data.items[0].safetyAlerts).toEqual([expect.objectContaining({ type: 'ALLERGY', overrideReason: 'Tolerated amoxicillin in 2025 under observation' })]);
    const audit = await prisma.emrAuditEvent.findFirst({ where: { resourceId: overridden.body.data.id, action: 'prescription.created' } });
    expect(audit.changedFields).toEqual(['safetyOverride', 'AMOX500:ALLERGY']);

    // Marking the allergy entered-in-error removes it from checks.
    await as(nurse).post(`/patients/${patient.id}/allergies/${allergy.body.data.id}/entered-in-error`, { reason: 'Recorded on the wrong patient' });
    expect((await as(nurse).get(`/patients/${patient.id}/allergies`)).body.data.items).toHaveLength(0);
  });

  it('checks maximum dose, dose units, duplicate therapy and same-class drugs', async () => {
    const { visit } = await openVisit();
    const overdose = await prescribe(visit, [para(1500, { frequency: 'QDS' })]);
    expect(overdose.status).toBe(409);
    expect(overdose.body.error.details[0]).toMatchObject({ type: 'MAX_DOSE', drugCode: 'PARA500' });
    expect((await prescribe(visit, [para(1, { doseUnit: 'g' })])).status).toBe(400);

    expect((await prescribe(visit, [{ drugCode: 'IBU400', dose: 400, doseUnit: 'mg', frequency: 'TDS', durationDays: 5 }])).status).toBe(201);
    const again = await prescribe(visit, [{ drugCode: 'IBU400', dose: 400, doseUnit: 'mg', frequency: 'BD', durationDays: 3 }]);
    expect(again.status).toBe(409);
    expect(again.body.error.details[0].type).toBe('DUPLICATE_THERAPY');
    const sameClass = await prescribe(visit, [{ drugCode: 'DICLO75_INJ', dose: 75, doseUnit: 'mg', frequency: 'STAT' }]);
    expect(sameClass.status).toBe(201); // MODERATE: shown, not blocking
    expect(sameClass.body.data.items[0].safetyAlerts).toEqual([expect.objectContaining({ type: 'DUPLICATE_CLASS', severity: 'MODERATE' })]);
  });

  it('computes quantities and enforces as-needed and controlled-drug rules', async () => {
    const { visit } = await openVisit();
    const created = await prescribe(visit, [
      para(1000),
      { drugCode: 'AL20_120', dose: 4, doseUnit: 'tablet', frequency: 'BD', durationDays: 3 },
      { drugCode: 'ORS', dose: 1, doseUnit: 'sachet', frequency: 'PRN', prnReason: 'After each loose stool', quantity: 10 },
    ]);
    expect(created.status).toBe(201);
    const qty = Object.fromEntries(created.body.data.items.map((i) => [i.drugCode, i.quantityPrescribed]));
    expect(qty).toEqual({ PARA500: 30, AL20_120: 24, ORS: 10 });
    const { visit: v2 } = await openVisit();
    expect((await prescribe(v2, [{ drugCode: 'ORS', dose: 1, doseUnit: 'sachet', frequency: 'PRN', prnReason: 'Diarrhoea' }])).status).toBe(400);
    expect((await prescribe(v2, [{ drugCode: 'TRAM50', dose: 50, doseUnit: 'mg', frequency: 'TDS', durationDays: 40 }])).status).toBe(400);
    expect((await prescribe(v2, [{ drugCode: 'NOPE', dose: 1, doseUnit: 'mg', frequency: 'OD', durationDays: 1 }])).status).toBe(400);
    expect((await as(nurse).post(`/encounters/${v2.id}/prescriptions`, { items: [para()] })).status).toBe(403);
  });
});

describe('review and dispensing', () => {
  it('dispenses FEFO across batches, exactly once per Idempotency-Key, and keeps the ledger balanced', async () => {
    await receive('AMLO5', 10, { batchNumber: 'AM-EARLY', expiryDate: EARLY });
    await receive('AMLO5', 100, { batchNumber: 'AM-LATE', expiryDate: LATE });
    const { visit } = await openVisit();
    const created = await prescribe(visit, [{ drugCode: 'AMLO5', dose: 5, doseUnit: 'mg', frequency: 'OD', durationDays: 30 }]);
    const rx = created.body.data;
    expect((await as(doctor).post(`/pharmacy/prescriptions/${rx.id}/approve`, {}, ifMatch(1))).status).toBe(403);
    expect((await as(pharmacist).post(`/pharmacy/prescriptions/${rx.id}/dispense`, { lines: [{ itemId: rx.items[0].id, quantity: 30 }] }, key())).status).toBe(409); // not approved yet
    await as(pharmacist).post(`/pharmacy/prescriptions/${rx.id}/approve`, {}, ifMatch(1));

    const url = `/pharmacy/prescriptions/${rx.id}/dispense`;
    const line = { lines: [{ itemId: rx.items[0].id, quantity: 30 }] };
    expect((await as(pharmacist).post(url, line)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await as(pharmacist).post(url, { lines: [{ itemId: rx.items[0].id, quantity: 31 }] }, key())).status).toBe(400);
    const headers = key();
    const done = await as(pharmacist).post(url, line, headers);
    expect(done.status).toBe(201);
    expect(done.body.data.prescriptionStatus).toBe('DISPENSED');
    expect(done.body.data.lines.map((l) => [l.batchNumber, l.quantity])).toEqual([['AM-EARLY', 10], ['AM-LATE', 20]]);

    const replay = await as(pharmacist).post(url, line, headers);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.id).toBe(done.body.data.id);
    expect(await onHand('AMLO5')).toBe(80);
    expect(await prisma.emrDispense.count({ where: { prescriptionId: rx.id } })).toBe(1);
    expect((await as(pharmacist).post(url, line, key())).status).toBe(409); // already fully dispensed
    expect((await balanced()).balanced).toBe(true);

    const detail = (await as(pharmacist).get(`/pharmacy/prescriptions/${rx.id}`)).body.data;
    expect(detail.dispenses[0].lines.map((l) => l.batchNumber)).toEqual(['AM-EARLY', 'AM-LATE']);
    expect(detail.items[0]).toMatchObject({ quantityDispensed: 30, status: 'COMPLETED', inStock: 80 });
  });

  it('is all-or-nothing when stock is short, then completes as a partial fill', async () => {
    await receive('CIPRO500', 12);
    const { visit } = await openVisit();
    const rx = await approved(visit, [{ drugCode: 'CIPRO500', dose: 500, doseUnit: 'mg', frequency: 'BD', durationDays: 7 }]);
    const itemId = rx.items[0].id;
    const short = await as(pharmacist).post(`/pharmacy/prescriptions/${rx.id}/dispense`, { lines: [{ itemId, quantity: 14 }] }, key());
    expect(short.status).toBe(409);
    expect(short.body.error.details[0]).toMatchObject({ drugCode: 'CIPRO500', requested: 14, available: 12 });
    expect(await onHand('CIPRO500')).toBe(12);
    const partial = await as(pharmacist).post(`/pharmacy/prescriptions/${rx.id}/dispense`, { lines: [{ itemId, quantity: 12 }] }, key());
    expect(partial.body.data.prescriptionStatus).toBe('PARTIALLY_DISPENSED');
    await receive('CIPRO500', 10);
    const rest = await as(pharmacist).post(`/pharmacy/prescriptions/${rx.id}/dispense`, { lines: [{ itemId, quantity: 2 }] }, key());
    expect(rest.body.data.prescriptionStatus).toBe('DISPENSED');
    expect(await onHand('CIPRO500')).toBe(8);
  });

  it('never dispenses expired stock', async () => {
    // Expired stock cannot be received through the API, so put one in directly (with its ledger row).
    const drug = await prisma.emrFormularyItem.findFirst({ where: { organizationId: A.organizationId, code: 'PRED5' } });
    const batch = await prisma.emrStockBatch.create({ data: { organizationId: A.organizationId, formularyItemId: drug.id, batchNumber: 'OLD', expiryDate: new Date(`${year - 1}-12-31`), quantityOnHand: 50 } });
    await prisma.emrStockMovement.create({ data: { organizationId: A.organizationId, batchId: batch.id, formularyItemId: drug.id, kind: 'RECEIPT', quantity: 50, balanceAfter: 50, userId: pharmacist.userId } });
    const { visit } = await openVisit();
    const rx = await approved(visit, [{ drugCode: 'PRED5', dose: 20, doseUnit: 'mg', frequency: 'OD', durationDays: 5 }]);
    const response = await as(pharmacist).post(`/pharmacy/prescriptions/${rx.id}/dispense`, { lines: [{ itemId: rx.items[0].id, quantity: 20 }] }, key());
    expect(response.status).toBe(409);
    expect(response.body.error.details[0].available).toBe(0);
    const levels = (await as(pharmacist).get('/pharmacy/stock?q=PRED5')).body.data.items[0];
    expect(levels).toMatchObject({ onHand: 0, expiredOnHand: 50 });
  });

  it('controlled medicines need a different, active pharmacy member as witness', async () => {
    await receive('TRAM50', 100);
    const { visit } = await openVisit();
    const rx = await approved(visit, [{ drugCode: 'TRAM50', dose: 50, doseUnit: 'mg', frequency: 'TDS', durationDays: 5 }]);
    const url = `/pharmacy/prescriptions/${rx.id}/dispense`;
    const lines = [{ itemId: rx.items[0].id, quantity: 15 }];
    expect((await as(pharmacist).post(url, { lines }, key())).body.error.code).toBe('WITNESS_REQUIRED');
    expect((await as(pharmacist).post(url, { lines, witnessUserId: pharmacist.userId }, key())).body.error.code).toBe('WITNESS_REQUIRED');
    expect((await as(pharmacist).post(url, { lines, witnessUserId: nurse.userId }, key())).body.error.code).toBe('WITNESS_REQUIRED');
    expect((await as(pharmacist).post(url, { lines, witnessUserId: bPharmacist.userId }, key())).body.error.code).toBe('WITNESS_REQUIRED');
    const witnessed = await as(pharmacist).post(url, { lines, witnessUserId: pharmacist2.userId }, key());
    expect(witnessed.status).toBe(201);
    expect(witnessed.body.data.witnessUserId).toBe(pharmacist2.userId);
  });

  it('returns put stock back (or write it off) and reopen the line; replays are safe', async () => {
    await receive('FESO4_200', 90);
    const { visit } = await openVisit();
    const rx = await approved(visit, [{ drugCode: 'FESO4_200', dose: 200, doseUnit: 'mg', frequency: 'TDS', durationDays: 10 }]);
    const dispensed = (await as(pharmacist).post(`/pharmacy/prescriptions/${rx.id}/dispense`, { lines: [{ itemId: rx.items[0].id, quantity: 30 }] }, key())).body.data;
    const lineId = dispensed.lines[0].id;
    const url = `/pharmacy/dispenses/${dispensed.id}/returns`;
    expect((await as(pharmacist).post(url, { lines: [{ lineId, quantity: 31 }], reason: 'Too many', restock: true }, key())).status).toBe(400);
    const headers = key();
    const back = await as(pharmacist).post(url, { lines: [{ lineId, quantity: 10 }], reason: 'Patient returned unopened strips', restock: true }, headers);
    expect(back.body.data.prescriptionStatus).toBe('PARTIALLY_DISPENSED');
    await as(pharmacist).post(url, { lines: [{ lineId, quantity: 10 }], reason: 'Patient returned unopened strips', restock: true }, headers); // replay
    expect(await onHand('FESO4_200')).toBe(70);
    const spoiled = await as(pharmacist).post(url, { lines: [{ lineId, quantity: 5 }], reason: 'Returned opened', restock: false }, key());
    expect(spoiled.status).toBe(201);
    expect(await onHand('FESO4_200')).toBe(70);
    const ledger = (await as(pharmacist).get('/pharmacy/stock/movements?formularyCode=FESO4_200')).body.data.items.slice(0, 3).map((m) => [m.kind, m.quantity]);
    expect(ledger).toEqual([['ADJUSTMENT', -5], ['RETURN', 5], ['RETURN', 10]]);
    const item = (await as(pharmacist).get(`/pharmacy/prescriptions/${rx.id}`)).body.data.items[0];
    expect(item).toMatchObject({ quantityDispensed: 15, status: 'ACTIVE' });
    expect((await balanced()).balanced).toBe(true);
  });

  it('cancel and reject stop dispensing but keep what was already dispensed', async () => {
    await receive('ZINC20', 50);
    const { visit } = await openVisit();
    const rx = await approved(visit, [{ drugCode: 'ZINC20', dose: 20, doseUnit: 'mg', frequency: 'OD', durationDays: 10 }]);
    const disp = await as(pharmacist).post(`/pharmacy/prescriptions/${rx.id}/dispense`, { lines: [{ itemId: rx.items[0].id, quantity: 4 }] }, key());
    expect(disp.status).toBe(201); // prescription is now at version 3 (created, approved, dispensed)
    const { visit: other } = await openVisit();
    expect((await as(doctor2).post(`/encounters/${other.id}/prescriptions/${rx.id}/cancel`, { reason: 'Wrong visit' }, ifMatch(3))).status).toBe(404);
    const cancelled = await as(doctor2).post(`/encounters/${visit.id}/prescriptions/${rx.id}/cancel`, { reason: 'Stopped: diarrhoea resolved' }, ifMatch(3));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Stopped: diarrhoea resolved' });
    expect(cancelled.body.data.items[0]).toMatchObject({ status: 'CANCELLED', quantityDispensed: 4 });
    expect((await as(pharmacist).post(`/pharmacy/prescriptions/${rx.id}/dispense`, { lines: [{ itemId: rx.items[0].id, quantity: 1 }] }, key())).status).toBe(409);

    const pending = (await prescribe(visit, [{ drugCode: 'OMEP20', dose: 20, doseUnit: 'mg', frequency: 'OD', durationDays: 14 }])).body.data;
    expect((await as(pharmacist).post(`/pharmacy/prescriptions/${pending.id}/reject`, {}, ifMatch(1))).status).toBe(400);
    const rejected = await as(pharmacist).post(`/pharmacy/prescriptions/${pending.id}/reject`, { reason: 'Already on esomeprazole' }, ifMatch(1));
    expect(rejected.body.data).toMatchObject({ status: 'REJECTED', rejectionReason: 'Already on esomeprazole' });
    expect(rejected.body.data.items[0].status).toBe('CANCELLED');
  });

  it('two pharmacists racing for the last packs: one succeeds, stock never goes negative', async () => {
    await receive('SALB_INH', 2);
    const rxs = [];
    for (let i = 0; i < 2; i += 1) {
      const { visit } = await openVisit();
      rxs.push(await approved(visit, [{ drugCode: 'SALB_INH', dose: 2, doseUnit: 'puff', frequency: 'PRN', prnReason: 'Wheeze', quantity: 2 }]));
    }
    const results = await Promise.all(rxs.map((rx, i) => as(i ? pharmacist2 : pharmacist).post(`/pharmacy/prescriptions/${rx.id}/dispense`, { lines: [{ itemId: rx.items[0].id, quantity: 2 }] }, key())));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await onHand('SALB_INH')).toBe(0);
    expect((await balanced()).balanced).toBe(true);
  });
});

describe('medication list, database invariants and isolation', () => {
  it('lists current medicines across visits; cancelled ones only in the full history', async () => {
    const { patient, visit } = await openVisit();
    const keep = await prescribe(visit, [para()]);
    const stop = await prescribe(visit, [{ drugCode: 'OMEP20', dose: 20, doseUnit: 'mg', frequency: 'OD', durationDays: 28 }]);
    await as(doctor).post(`/encounters/${visit.id}/prescriptions/${stop.body.data.id}/cancel`, { reason: 'Not needed' }, ifMatch(1));
    const current = (await as(nurse).get(`/patients/${patient.id}/medications`)).body.data.items.map((i) => i.drugCode);
    expect(current).toEqual(['PARA500']);
    const all = (await as(nurse).get(`/patients/${patient.id}/medications?scope=all`)).body.data.items.map((i) => i.drugCode).sort();
    expect(all).toEqual(['OMEP20', 'PARA500']);
    expect(keep.body.data.items[0].safetyAlerts).toEqual([]);
    expect((await as(reception).get(`/patients/${patient.id}/medications`)).status).toBe(403);
  });

  it('the database itself refuses negative stock, ledger edits, and over-returns', async () => {
    const tenant = { organizationId: A.organizationId };
    const batch = await receive('ORS', 5);
    await expect(withTenant(tenant, (tx) => tx.emrStockBatch.updateMany({ where: { id: batch.id }, data: { quantityOnHand: -1 } }))).rejects.toThrow();
    await expect(withTenant(tenant, (tx) => tx.emrStockMovement.updateMany({ where: { batchId: batch.id }, data: { quantity: 500 } }))).rejects.toThrow();
    await expect(prisma.emrStockMovement.deleteMany({ where: { batchId: batch.id } })).rejects.toThrow();
    const line = await prisma.emrDispenseLine.findFirst({ where: { organizationId: A.organizationId } });
    await expect(withTenant(tenant, (tx) => tx.emrDispenseLine.updateMany({ where: { id: line.id }, data: { quantityReturned: line.quantity + 1 } }))).rejects.toThrow();
    // The request role cannot rewrite a dispense line's quantity at all (column-level grant).
    await expect(withTenant(tenant, (tx) => tx.emrDispenseLine.updateMany({ where: { id: line.id }, data: { quantity: 999 } }))).rejects.toThrow();
  });

  it('another organization cannot see or touch prescriptions, stock or allergies', async () => {
    const { patient, visit } = await openVisit();
    const rx = (await prescribe(visit, [para()])).body.data;
    const batch = await receive('PARA500', 20);
    expect((await as(bPharmacist).get(`/pharmacy/prescriptions/${rx.id}`)).status).toBe(404);
    expect((await as(bPharmacist).post(`/pharmacy/prescriptions/${rx.id}/approve`, {}, ifMatch(1))).status).toBe(404);
    expect((await as(bPharmacist).post(`/pharmacy/prescriptions/${rx.id}/dispense`, { lines: [{ itemId: rx.items[0].id, quantity: 1 }] }, key())).status).toBe(404);
    expect((await as(bPharmacist).get('/pharmacy/prescriptions')).body.data.items.map((p) => p.id)).not.toContain(rx.id);
    expect((await as(bPharmacist).post(`/pharmacy/stock/batches/${batch.id}/adjust`, { quantity: -1, reason: 'LOST' }, ifMatch(1))).status).toBe(404);
    expect((await as(bPharmacist).get(`/patients/${patient.id}/allergies`)).status).toBe(404);
    expect((await balanced(bPharmacist)).batchesChecked).toBe(0);
  });
});
