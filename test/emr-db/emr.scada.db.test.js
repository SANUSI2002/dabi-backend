// Equipment intelligence (SCADA) against real Postgres with RLS on: register equipment, issue a device
// key (shown once, stored hashed), ingest heartbeats/readings/events from that key only, threshold alarms
// raised once per cause, the alarm lifecycle by permission, location history on the timeline, revoked
// and forged keys refused, and other hospitals kept out.
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
});
