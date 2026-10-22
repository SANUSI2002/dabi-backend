// Equipment intelligence (SCADA) against real Postgres with RLS on: register equipment, issue a device
// key (shown once, stored hashed), ingest heartbeats/readings/events from that key only, threshold alarms
// raised once per cause, the alarm lifecycle by permission, location history on the timeline, revoked
// and forged keys refused, other hospitals kept out — and looking after the equipment: work orders, calibration,
// consumables used by device tests, usage sessions and warranty claims.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant, prisma } from './fixtures.js';

const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const as = (who) => {
  const url = (path) => `/api/v1/emr/organizations/${who.organizationId}/scada${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    patch: (path, body, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
    put: (path, body) => request(app).put(url(path)).set('Authorization', who.auth).send(body),
  };
};
const device = (key, body) => request(app).post('/api/v1/emr/scada/ingest').set('Authorization', `Device ${key}`).send(body);
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };

let A; let B; let admin; let nurse; let doctor; let bAdmin; let fridge; let key;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const centre = async (who = admin) => ok(await as(who).get(''));

beforeAll(async () => {
  A = await createTenant('scadaA');
  B = await createTenant('scadaB');
  admin = { ...A };
  nurse = await member(A, ['NURSE']);
  doctor = await member(A, ['DOCTOR']);
  bAdmin = { ...B };
});

describe('equipment intelligence', () => {
  it('registers equipment with a tag, for engineers only, and starts its timeline', async () => {
    const body = { category: 'Pharmacy Cold Chain', name: 'Vaccine fridge — Pharmacy', manufacturer: 'Haier', model: 'HBC-260', location: { building: 'Main', department: 'Pharmacy' }, compliance: { calibrationRequired: true, calibrationIntervalDays: 180 } };
    expect((await as(nurse).post('/equipment', body)).status).toBe(403);
    fridge = ok(await as(admin).post('/equipment', body), 201);
    expect(fridge.equipmentId).toBe('EQ-CLD-0001');
    const [e] = (await centre(nurse)).equipment;
    // no device yet: nothing is invented
    expect(e).toMatchObject({ equipmentId: 'EQ-CLD-0001', technical: { integrationKind: 'NOT_CONFIGURED' }, connectivity: 'Unknown', machineState: 'Unknown', readings: [] });
    expect((await centre(bAdmin)).equipment).toEqual([]);
  });

  it('issues a device key once, stored only as a hash', async () => {
    const issued = ok(await as(admin).post(`/equipment/${fridge.id}/device-keys`, { label: 'Fridge logger' }), 201);
    key = issued.key;
    expect(key).toMatch(/^sdk\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    const stored = await prisma.emrScadaDeviceKey.findUnique({ where: { id: issued.id } });
    expect(stored.secretHash).toHaveLength(64);
    expect(JSON.stringify(stored)).not.toContain(key.split('.')[3]);
    const detail = ok(await as(admin).get(`/equipment/${fridge.id}`));
    expect(detail.deviceKeys).toEqual([expect.objectContaining({ label: 'Fridge logger', revokedAt: null })]);
    expect(JSON.stringify(detail)).not.toContain(key.split('.')[3]);
  });

  it('takes readings from the device, raising one threshold alarm per parameter while it is open', async () => {
    expect((await device('sdk.nonsense', { readings: [] })).status).toBe(401);
    expect((await device(key, { readings: [{ parameter: 'fio2', value: 30 }] })).status).toBe(400); // not a fridge parameter
    const first = ok(await device(key, { heartbeat: { latencyMs: 40 }, machineState: 'Running', readings: [{ parameter: 'temperature', value: 5.2 }, { parameter: 'temperature', value: 11 }], events: [{ type: 'POWER_ON', idempotencyKey: 'boot-0001' }] }), 202);
    expect(first).toMatchObject({ readings: 2, events: 1, alarms: 1 });
    // the same event again is kept once, and the still-warm fridge does not raise a second alarm
    expect(ok(await device(key, { readings: [{ parameter: 'temperature', value: 12.5 }], events: [{ type: 'POWER_ON', idempotencyKey: 'boot-0001' }] }), 202)).toMatchObject({ readings: 1, events: 0, alarms: 0 });
    const data = await centre();
    const [e] = data.equipment;
    expect(e).toMatchObject({ connectivity: 'Online', machineState: 'Running', latencyMs: 40, technical: { integrationKind: 'REAL_DEVICE' } });
    expect(e.readings).toEqual([expect.objectContaining({ key: 'temperature', value: 12.5, severity: 'Critical' })]);
    const alarms = data.alarms.filter((a) => a.category === 'Threshold Breach');
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({ source: 'DEVICE_GATEWAY', parameter: 'temperature', value: 12.5, status: 'Raised', severity: 'Medium' });
    const detail = ok(await as(doctor).get(`/equipment/${fridge.id}?parameter=temperature&hours=1`));
    expect(detail.history.temperature.map((p) => p.value)).toEqual([5.2, 11, 12.5]);
    expect(detail.timeline.map((t) => t.type)).toEqual(expect.arrayContaining(['REGISTERED', 'POWER_ON', 'ALARM_RAISED']));
  });

  it('walks the alarm lifecycle by permission, on the timeline', async () => {
    let alarm = (await centre()).alarms.find((a) => a.category === 'Threshold Breach');
    ok(await as(nurse).post(`/alarms/${alarm.id}/acknowledge`, {}, ifMatch(alarm.version)));
    alarm = (await centre()).alarms.find((a) => a.id === alarm.id);
    expect(alarm).toMatchObject({ status: 'Acknowledged', acknowledgedBy: expect.any(String) });
    expect((await as(nurse).post(`/alarms/${alarm.id}/resolve`, { resolution: 'x' }, ifMatch(alarm.version))).status).toBe(403);
    ok(await as(admin).post(`/alarms/${alarm.id}/resolve`, { resolution: 'Door seal replaced; temperature back to 4.8 °C' }, ifMatch(alarm.version)));
    expect((await as(admin).post(`/alarms/${alarm.id}/resolve`, {}, ifMatch(alarm.version + 1))).status).toBe(409);
    // resolved, a new breach raises a fresh alarm
    expect(ok(await device(key, { readings: [{ parameter: 'temperature', value: 13 }] }), 202).alarms).toBe(1);
  });

  it('records moves on the timeline, and a revoked key stops reporting', async () => {
    const [e] = (await centre()).equipment;
    ok(await as(admin).patch(`/equipment/${fridge.id}`, { location: { building: 'Main', department: 'Immunization' }, reason: 'Moved for the vaccine week' }, ifMatch(e.version)));
    const moved = ok(await as(admin).get(`/equipment/${fridge.id}`)).timeline.find((t) => t.type === 'LOCATION_CHANGED');
    expect(moved.detail).toBe('Main · Pharmacy → Main · Immunization (Moved for the vaccine week)');
    const keyId = key.split('.')[2];
    ok(await as(admin).post(`/equipment/${fridge.id}/device-keys/${keyId}/revoke`));
    expect((await device(key, { readings: [{ parameter: 'temperature', value: 5 }] })).status).toBe(401);
    // a key is bound to its own hospital: forging the organization part fails
    expect((await device(key.replace(A.organizationId, B.organizationId), { readings: [] })).status).toBe(401);
  });

  describe('looking after equipment', () => {
    let analyzer; let analyzerKey;
    const care = async (who = admin) => ok(await as(who).get('/care'));
    it('completes a work order only after a passed return-to-service test, resolving its maintenance alarm', async () => {
      analyzer = ok(await as(admin).post('/equipment', {
        category: 'Laboratory Analyzer', name: 'Chemistry analyzer', location: { building: 'Main', department: 'Laboratory' },
        lifecycle: { commissioningDate: '2025-01-10' }, compliance: { calibrationRequired: true, calibrationIntervalDays: 60, preventiveMaintenanceIntervalDays: 180 },
      }), 201);
      // commissioned long ago and never serviced or calibrated: both overdue, raised once each
      await care();
      await care();
      const due = (await centre()).alarms.filter((a) => a.equipmentId === analyzer.id);
      expect(due.map((a) => a.category).sort()).toEqual(['Calibration', 'Maintenance']);
      expect((await as(nurse).post(`/equipment/${analyzer.id}/work-orders`, { type: 'Preventive', severity: 'Low', description: 'PM' })).status).toBe(403);
      const wo = ok(await as(admin).post(`/equipment/${analyzer.id}/work-orders`, { type: 'Preventive', severity: 'Medium', description: 'Six-monthly PM' }), 201);
      let order = (await care()).workOrders.find((w) => w.id === wo.id);
      expect(order.checklist.map((i) => i.label)).toContain('QC run');
      ok(await as(admin).patch(`/work-orders/${wo.id}`, { status: 'In Progress', technician: 'Biomed Eng. Musa' }, ifMatch(order.version)));
      ok(await as(admin).patch(`/work-orders/${wo.id}`, { status: 'Testing', partsUsed: [{ name: 'Lamp', qty: 1, cost: 45000 }], laborCost: 20000 }, ifMatch(order.version + 1)));
      expect((await as(admin).patch(`/work-orders/${wo.id}`, { status: 'Completed' }, ifMatch(order.version + 2))).body.error.message).toMatch(/return-to-service/);
      ok(await as(admin).patch(`/work-orders/${wo.id}`, { status: 'Completed', returnToServiceTested: true, returnToServiceNote: 'QC in range' }, ifMatch(order.version + 2)));
      order = (await care()).workOrders.find((w) => w.id === wo.id);
      expect(order).toMatchObject({ status: 'Completed', returnToServiceTested: true, partsUsed: [expect.objectContaining({ name: 'Lamp' })] });
      const alarms = (await centre()).alarms.filter((a) => a.equipmentId === analyzer.id);
      expect(alarms.find((a) => a.category === 'Maintenance')).toMatchObject({ status: 'Resolved', resolution: expect.stringMatching(/WO-.* completed and tested/) });
      expect((await care()).due[analyzer.id].maintenanceDue).toEqual(expect.any(String));
    });

    it('needs a certificate for a passed calibration, which resolves the calibration alarm', async () => {
      const cal = ok(await as(admin).post(`/equipment/${analyzer.id}/calibrations`, { scheduledFor: new Date().toISOString(), vendor: 'Beckman Coulter WA' }), 201);
      const v1 = (await care()).calibrations.find((x) => x.id === cal.id).version;
      expect((await as(admin).patch(`/calibrations/${cal.id}`, { status: 'Completed', result: 'Pass' }, ifMatch(v1))).status).toBe(400);
      ok(await as(admin).patch(`/calibrations/${cal.id}`, { status: 'Completed', result: 'Pass', certificateNumber: 'CAL-2026-114', certificateExpiry: new Date(Date.now() + 60 * 86_400_000).toISOString() }, ifMatch(v1)));
      expect((await centre()).alarms.find((a) => a.equipmentId === analyzer.id && a.category === 'Calibration')).toMatchObject({ status: 'Resolved' });
    });

    it('uses a consumable per device test, opens and closes usage sessions, and alarms on low stock', async () => {
      analyzerKey = ok(await as(admin).post(`/equipment/${analyzer.id}/device-keys`, { label: 'AU480 LIS link' }), 201).key;
      const reagent = ok(await as(admin).post(`/equipment/${analyzer.id}/consumables`, { name: 'Glucose reagent', lotNumber: 'GL-24', expiryDate: '2030-01-31', unit: 'test', quantityOnHand: 3, reorderThreshold: 2, costPerUnit: 350 }), 201);
      expect(ok(await device(analyzerKey, { events: [{ type: 'TEST_STARTED', idempotencyKey: 'run-0000001', correlationId: 'run-1', operator: 'Kemi Adeola', testName: 'Fasting blood sugar' }] }), 202).events).toBe(1);
      expect((await device(analyzerKey, { events: [{ type: 'TEST_STARTED', idempotencyKey: 'run-0000002' }] })).status).toBe(400); // no correlationId
      ok(await device(analyzerKey, { events: [{ type: 'TEST_COMPLETED', idempotencyKey: 'run-0000001-done', correlationId: 'run-1' }] }), 202);
      const data = await care();
      expect(data.usageSessions.find((s) => s.equipmentId === analyzer.id)).toMatchObject({ operator: 'Kemi Adeola', testName: 'Fasting blood sugar', outcome: 'Completed', endedAt: expect.any(String) });
      expect(data.consumables.find((x) => x.id === reagent.id).quantityOnHand).toBe(2);
      expect((await centre()).alarms.find((a) => a.equipmentId === analyzer.id && a.category === 'Consumable')).toMatchObject({ severity: 'Medium', description: expect.stringMatching(/low on stock/) });
      const item = (await care()).consumables.find((x) => x.id === reagent.id);
      ok(await as(admin).post(`/consumables/${reagent.id}/adjust`, { quantityDelta: 50 }, ifMatch(item.version)));
      expect((await centre()).alarms.find((a) => a.equipmentId === analyzer.id && a.category === 'Consumable')).toMatchObject({ status: 'Resolved' });
    });

    it('tracks warranty claims only while the warranty is in force', async () => {
      expect((await as(admin).post(`/equipment/${analyzer.id}/warranty-claims`, { issue: 'Lamp failure' })).status).toBe(409);
      ok(await as(admin).put(`/equipment/${analyzer.id}/warranty`, { provider: 'Beckman Coulter WA', start: '2025-01-10', end: '2030-01-09', coverage: 'Parts and labour', slaHours: 48 }));
      const claim = ok(await as(admin).post(`/equipment/${analyzer.id}/warranty-claims`, { issue: 'Lamp failure', claimNumber: 'BC-7781' }), 201);
      ok(await as(admin).patch(`/warranty-claims/${claim.id}`, { status: 'Approved' }, ifMatch(1)));
      expect((await as(admin).patch(`/warranty-claims/${claim.id}`, { status: 'Rejected' }, ifMatch(2))).status).toBe(409);
      ok(await as(admin).patch(`/warranty-claims/${claim.id}`, { status: 'Completed', repairedUnderWarranty: true, costRecovered: 45000 }, ifMatch(2)));
      expect((await care()).claims[0]).toMatchObject({ status: 'Completed', repairedUnderWarranty: true, costRecovered: 45000, resolvedAt: expect.any(String) });
    });
  });
});
