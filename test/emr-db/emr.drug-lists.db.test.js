// Drug categories and drug classes against real Postgres with RLS on: both are the organization's own lists,
// kept by the pharmacy; formulary items are filed under them (checked when saved), and prescribers search
// the formulary by category.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant } from './fixtures.js';

const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const api = (base) => (who) => {
  const url = (path) => `/api/v1/${base}/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}) => request(app).post(url(path)).set('Authorization', who.auth).send(body),
    patch: (path, body = {}, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};
const emr = api('emr'); const config = api('org-config');
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };
const drug = (code, extra = {}) => ({ code, genericName: code, form: 'Tablet', strength: '1 mg', doseUnit: 'mg', dispenseUnit: 'tablet', defaultRoute: 'PO', ...extra });

let A; let doctor; let nurse; let pharmacist;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const list = async (key) => ok(await config(pharmacist).get('')).data[key];

beforeAll(async () => {
  A = await createTenant('dlA');
  doctor = await member(A, ['DOCTOR']);
  nurse = await member(A, ['NURSE']);
  pharmacist = await member(A, ['PHARMACIST']);
});

describe('drug categories and classes', () => {
  it('starts with categories and classes, and files the starter formulary under them', async () => {
    expect((await list('drug-categories')).map((i) => i.code)).toEqual(expect.arrayContaining(['ANTIBIOTIC', 'ANTIHYPERTENSIVE', 'ANTIDIABETIC', 'OTHER']));
    expect((await list('drug-classes')).find((i) => i.code === 'PENICILLIN')).toMatchObject({ system: true });
    const antibiotics = ok(await emr(doctor).get('/pharmacy/formulary?category=ANTIBIOTIC')).items.map((i) => i.code);
    expect(antibiotics).toEqual(expect.arrayContaining(['AMOX500', 'CEFTRI1G_INJ', 'CIPRO500']));
    expect(antibiotics).not.toContain('PARA500');
  });

  it('lets the pharmacy add categories and classes, and files new drugs only under ones on the lists', async () => {
    expect((await config(nurse).post('/master-data/drug-categories', { label: 'Antituberculars', code: 'ANTI_TB' })).status).toBe(403);
    expect((await config(doctor).post('/master-data/drug-classes', { label: 'Rifamycin', code: 'RIFAMYCIN' })).status).toBe(403);
    ok(await config(pharmacist).post('/master-data/drug-categories', { label: 'Antituberculars', code: 'ANTI_TB' }), 201);

    const refused = await emr(pharmacist).post('/pharmacy/formulary', drug('RIF150', { category: 'ANTI_TB', drugClasses: ['RIFAMYCIN'] }));
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/RIFAMYCIN/);
    expect((await emr(pharmacist).post('/pharmacy/formulary', drug('RIF150', { category: 'NOT_A_CATEGORY' }))).body.error.message).toMatch(/not an active drug category/);
    ok(await config(pharmacist).post('/master-data/drug-classes', { label: 'Rifamycin', code: 'RIFAMYCIN' }), 201);
    ok(await emr(pharmacist).post('/pharmacy/formulary', drug('RIF150', { category: 'ANTI_TB', drugClasses: ['RIFAMYCIN'] })), 201);
    expect(ok(await emr(doctor).get('/pharmacy/formulary?category=ANTI_TB')).items.map((i) => i.code)).toEqual(['RIF150']);
  });

  it('keeps a switched-off category on the drugs that have it, but files no new drug under it', async () => {
    const tb = (await list('drug-categories')).find((i) => i.code === 'ANTI_TB');
    ok(await config(pharmacist).patch(`/master-data/drug-categories/${tb.id}`, { active: false }, ifMatch(tb.version)));
    const rif = ok(await emr(pharmacist).get('/pharmacy/formulary?q=RIF150')).items[0];
    ok(await emr(pharmacist).patch('/pharmacy/formulary/RIF150', { category: 'ANTI_TB', reorderLevel: 30 }, ifMatch(rif.version)));
    expect((await emr(pharmacist).post('/pharmacy/formulary', drug('ETH400', { category: 'ANTI_TB' }))).status).toBe(400);
  });

  it('lets a prescriber search by category, from the pharmacy or EMDEX', async () => {
    const pharmacy = ok(await emr(doctor).get('/pharmacy/drug-search?category=ANTIHYPERTENSIVE&source=formulary'));
    expect(pharmacy).toMatchObject({ reference: [], referenceStatus: 'ok' });
    expect(pharmacy.formulary.map((i) => i.code)).toEqual(['AMLO5']);
    expect(ok(await emr(doctor).get('/pharmacy/drug-search?q=amox&category=ANTIBIOTIC')).formulary.map((i) => i.code)).toEqual(expect.arrayContaining(['AMOX500', 'AMOXCLAV625']));
    // EMDEX alone: no formulary rows; this test deployment has no EMDEX token, and says so
    expect(ok(await emr(doctor).get('/pharmacy/drug-search?q=amlodipine&source=emdex'))).toEqual({ formulary: [], reference: [], referenceStatus: 'not_configured' });
    expect((await emr(doctor).get('/pharmacy/drug-search')).status).toBe(400); // a name or a category
  });
});
