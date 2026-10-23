// Finance attachments against real Postgres with RLS on, with private storage and the virus scanner
// replaced by in-memory stand-ins: a file goes to quarantine, cannot be opened until scanned CLEAN, then
// opens through a short-lived link; infected files never open and their bytes are deleted; retries are
// idempotent; removal keeps the record; other hospitals see nothing.
import { randomUUID } from 'node:crypto';
import { Blob, Buffer } from 'node:buffer';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { addMember, createTenant } from './fixtures.js';

const objects = new Map();
const client = { storage: {
  getBucket: async () => ({ data: { public: false } }),
  from: (bucket) => ({
    upload: async (path, bytes) => { const key = `${bucket}/${path}`; if (objects.has(key)) return { error: { statusCode: 409 } }; objects.set(key, Buffer.from(bytes)); return { data: { path } }; },
    download: async (path) => (objects.has(`${bucket}/${path}`) ? { data: new Blob([objects.get(`${bucket}/${path}`)]) } : { error: {} }),
    remove: async (paths) => { paths.forEach((path) => objects.delete(`${bucket}/${path}`)); return {}; },
    createSignedUrl: async (path) => ({ data: { signedUrl: `https://synthetic.supabase.co/sign/${path}?token=synthetic` } }),
  }),
} };
vi.mock('../../src/config/privateStorage.js', async (original) => ({ ...(await original()), privateStorageClient: () => client }));
const { app } = await import('../../src/app.js');
const worker = await import('../../src/modules/accounting/attachments/attachments.worker.js');

const pdf = Buffer.from('%PDF-1.4 synthetic supplier invoice, no real data');
const scan = (verdict = 'CLEAN') => worker.scanFinanceAttachments({ client, isConfigured: () => true, scan: async () => ({ verdict, scannerVersion: 'synthetic scanner' }) });
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };
const as = (who) => {
  const url = (path) => `/api/v1/accounting/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}) => request(app).post(url(path)).set('Authorization', who.auth).send(body),
    attach: (bill, { bytes = pdf, type = 'application/pdf', name = 'emzor-invoice.pdf', key = randomUUID() } = {}) => request(app)
      .post(url(`/attachments/receive?entityType=bill&entityId=${bill.id}&entityLabel=${encodeURIComponent(bill.number ?? 'Bill')}`))
      .set('Authorization', who.auth).set('Content-Type', type).set('X-Document-Filename', encodeURIComponent(name)).set('Idempotency-Key', key).send(bytes),
  };
};

let A; let B; let finance; let viewer; let otherFinance; let bill;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
beforeAll(async () => {
  process.env.CLOUDMERSIVE_API_KEY = 'synthetic-only'; process.env.CLOUDMERSIVE_CREDENTIAL_PROCESSING_APPROVED = 'true';
  process.env.SUPABASE_URL = 'https://synthetic.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-only';
  A = await createTenant('faA', { modules: ['emr', 'accounting'] });
  B = await createTenant('faB', { modules: ['emr', 'accounting'] });
  finance = await member(A, ['FINANCE_OFFICER']);
  viewer = await member(A, ['HOSPITAL_ADMIN']);
  otherFinance = await member(B, ['FINANCE_OFFICER']);
  const vendor = ok(await as(finance).post('/payables/vendors', { name: 'Emzor Pharmaceuticals', category: 'Pharmaceuticals', openingBalance: 0 }), 201);
  bill = ok(await as(finance).post('/payables/bills', { vendorId: vendor.id, date: new Date().toISOString(), lines: [{ accountNumber: 5230, description: 'Generator service', qty: 1, unitPrice: 120000, taxRateId: 'tax-vat-exempt' }] }), 201);
});

describe('finance attachments', () => {
  it('quarantines a file until it is scanned clean, then opens it through a short-lived link', async () => {
    const received = ok(await as(finance).attach(bill), 202);
    expect(received).toMatchObject({ entityType: 'bill', entityId: bill.id, filename: 'emzor-invoice.pdf', status: 'PENDING_SCAN', version: 1 });
    expect(received).not.toHaveProperty('objectKey');
    expect((await as(finance).post(`/attachments/${received.id}/download`)).body.error.message).toMatch(/still being checked/);
    expect(await scan()).toBe(1);
    const link = ok(await as(viewer).post(`/attachments/${received.id}/download`));
    expect(link).toMatchObject({ expiresInSeconds: 60, filename: 'emzor-invoice.pdf' });
    expect(link.url).toMatch(/clean\//);
    await worker.cleanFinanceAttachments({ client });
    expect([...objects.keys()].filter((k) => k.includes(received.id) || k.includes('quarantine')).every((k) => k.includes('clean/'))).toBe(true); // quarantined bytes deleted, clean copy kept
    expect(ok(await as(viewer).get('/attachments')).items.find((a) => a.id === received.id)).toMatchObject({ status: 'CLEAN', uploadedBy: expect.any(String) });
  });

  it('never opens an infected file, and deletes its bytes', async () => {
    const received = ok(await as(finance).attach(bill, { name: 'suspicious.pdf' }), 202);
    await scan('INFECTED');
    await worker.cleanFinanceAttachments({ client });
    expect((await as(finance).post(`/attachments/${received.id}/download`)).body.error.message).toMatch(/failed the security check/);
    expect([...objects.keys()].some((k) => k.includes(received.id))).toBe(false);
  });

  it('refuses a file that is not what it says, a retry with other bytes, and a record that does not exist', async () => {
    expect((await as(finance).attach(bill, { bytes: Buffer.from('not a pdf at all'), name: 'fake.pdf' })).body.error.message).toMatch(/not the type/);
    const key = randomUUID();
    const first = ok(await as(finance).attach(bill, { key, name: 'retry.pdf' }), 202);
    expect(ok(await as(finance).attach(bill, { key, name: 'retry.pdf' }), 202).id).toBe(first.id); // same upload, same attachment
    expect((await as(finance).attach(bill, { key, bytes: Buffer.from('%PDF-other bytes'), name: 'retry.pdf' })).body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await as(finance).attach({ id: randomUUID(), number: 'X' })).status).toBe(404);
    expect(ok(await as(finance).attach(bill, { name: 'retry.pdf' }), 202).version).toBe(2); // same name again: the next version
    await scan();
  });

  it('lets only finance staff attach and remove, keeps the removal on record, and keeps hospitals apart', async () => {
    expect((await as(viewer).attach(bill)).status).toBe(403);
    const received = ok(await as(finance).attach(bill, { name: 'to-remove.pdf' }), 202);
    expect((await as(otherFinance).post(`/attachments/${received.id}/download`)).status).toBe(404);
    expect(ok(await as(otherFinance).get('/attachments')).items).toEqual([]);
    expect((await as(viewer).post(`/attachments/${received.id}/remove`)).status).toBe(403);
    ok(await as(finance).post(`/attachments/${received.id}/remove`));
    expect(ok(await as(finance).get('/attachments')).items.some((a) => a.id === received.id)).toBe(false);
    await worker.cleanFinanceAttachments({ client });
    expect([...objects.keys()].some((k) => k.includes(received.id))).toBe(false);
  });
});
