// Fast EMR tests (no database): request guards, tenant resolution, entitlement cache, per-tenant
// rate limiting, error envelope, crypto and webhook helpers. Real-database behaviour (RLS,
// idempotency, concurrency, webhooks) is covered by `npm run test:emr`.
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const orgA = '11111111-1111-4111-8111-111111111111';
const orgB = '22222222-2222-4222-8222-222222222222';
const patientId = '33333333-3333-4333-8333-333333333333';

const tx = vi.hoisted(() => ({
  $executeRawUnsafe: vi.fn(), $executeRaw: vi.fn(), $queryRaw: vi.fn(),
  emrPatient: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  emrAuditEvent: { create: vi.fn() },
  emrOutboxEvent: { create: vi.fn() },
}));
const db = vi.hoisted(() => ({ platformApplication: { findUnique: vi.fn() }, $transaction: vi.fn() }));
const access = vi.hoisted(() => ({ organizationId: null, permissions: [] }));

vi.mock('../src/config/db.js', () => ({ default: db }));
vi.mock('../src/middleware/authMiddleware.js', () => ({
  protect: (req, res, next) => (req.get('authorization') ? (req.user = { id: 'user-1', organizationId: access.organizationId }, next()) : res.status(401).json({ status: 'error' })),
}));
vi.mock('../src/middleware/accessMiddleware.js', () => ({
  requireOrganization: (req, _res, next) => {
    req.accessContext = { organization: { id: access.organizationId, facilityId: 'facility-1', type: 'HOSPITAL' }, roles: [], permissions: access.permissions };
    next();
  },
  requirePlatform: (req, res) => res.status(403).json({ status: 'error' }),
}));

const { default: emrRoutes } = await import('../src/modules/emr/emr.routes.js');
const { clearEntitlementCache } = await import('../src/modules/emr/core/context.js');
const { resetTenantRateLimits } = await import('../src/modules/emr/core/rateLimit.js');
const { encryptSecret, decryptSecret, newWebhookSecret } = await import('../src/modules/emr/core/secrets.js');
const { backoffMs, signPayload, validateWebhookUrl, MAX_ATTEMPTS } = await import('../src/modules/emr/core/outbox.js');
const { requestHash } = await import('../src/modules/emr/core/idempotency.js');
const { withTenant } = await import('../src/modules/emr/core/db.js');

const app = express();
app.use(express.json());
app.use('/api/v1/emr', emrRoutes);

const approved = { status: 'APPROVED', setupCompletedAt: new Date(), packageVersion: { status: 'PUBLISHED', moduleKeys: ['emr'] } };
const patients = (org = orgA) => `/api/v1/emr/organizations/${org}/patients`;
const get = (url) => request(app).get(url).set('Authorization', 'Bearer t');

beforeEach(() => {
  vi.resetAllMocks();
  clearEntitlementCache();
  resetTenantRateLimits();
  access.organizationId = orgA;
  access.permissions = ['patient.read', 'patient.register', 'patient.update'];
  db.platformApplication.findUnique.mockResolvedValue(approved);
  db.$transaction.mockImplementation((work) => work(tx));
  tx.emrPatient.findMany.mockResolvedValue([]);
  tx.emrPatient.count.mockResolvedValue(0);
  process.env.EMR_API_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.EMR_API_ENABLED;
  delete process.env.EMR_PATIENT_REGISTRY_ENABLED;
  delete process.env.EMR_TENANT_RATE_LIMIT_PER_MINUTE;
});

describe('EMR request guards', () => {
  it('requires authentication', async () => {
    expect((await request(app).get(patients())).status).toBe(401);
  });

  it('UC-1b: rejects another tenant\'s URL before any lookup', async () => {
    const response = await get(patients(orgB));
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ORGANIZATION_ACCESS_DENIED');
    expect(db.platformApplication.findUnique).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a malformed organization id', async () => {
    const response = await get(patients('not-a-uuid'));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('UC-6: refuses a tenant without EMR entitlement, and caches the decision briefly', async () => {
    db.platformApplication.findUnique.mockResolvedValue({ ...approved, setupCompletedAt: null });
    const first = await get(patients());
    expect(first.status).toBe(403);
    expect(first.body.error.code).toBe('EMR_ACCESS_DENIED');
    await get(patients());
    expect(db.platformApplication.findUnique).toHaveBeenCalledTimes(1);
    clearEntitlementCache();
    db.platformApplication.findUnique.mockResolvedValue(approved);
    expect((await get(patients())).status).toBe(200);
  });

  it('stays closed (503) while the EMR API switch is off; the legacy switch still works', async () => {
    delete process.env.EMR_API_ENABLED;
    const off = await get(patients());
    expect(off.status).toBe(503);
    expect(off.body.error.code).toBe('EMR_PATIENT_REGISTRY_DISABLED');
    process.env.EMR_PATIENT_REGISTRY_ENABLED = 'true';
    expect((await get(patients())).status).toBe(200);
  });

  it('UC-8: enforces permission codes', async () => {
    access.permissions = [];
    const response = await get(patients());
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('PERMISSION_DENIED');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('UC-7: one tenant exhausting its budget does not throttle another', async () => {
    process.env.EMR_TENANT_RATE_LIMIT_PER_MINUTE = '2';
    expect((await get(patients())).status).toBe(200);
    expect((await get(patients())).status).toBe(200);
    const limited = await get(patients());
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    access.organizationId = orgB;
    expect((await get(patients(orgB))).status).toBe(200);
  });

  it('echoes a well-formed request id and replaces a malformed one', async () => {
    const good = await get(patients()).set('X-Request-Id', 'client-req-12345');
    expect(good.headers['x-request-id']).toBe('client-req-12345');
    const bad = await get(patients()).set('X-Request-Id', 'bad id with spaces');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('marks responses no-store and returns 404 in the EMR envelope for unknown paths', async () => {
    expect((await get(patients())).headers['cache-control']).toBe('no-store');
    const missing = await get('/api/v1/emr/nothing-here');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });
});

describe('patients (route level)', () => {
  it('lists inside a tenant transaction as the restricted role, filtered by tenant, and audits the read', async () => {
    const response = await get(`${patients()}?q=ada`);
    expect(response.status).toBe(200);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL ROLE sabi_emr_app');
    expect(tx.emrPatient.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: orgA }) }));
    expect(tx.emrAuditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ organizationId: orgA, action: 'patient.searched', changedFields: [] }) });
    expect(JSON.stringify(tx.emrAuditEvent.create.mock.calls)).not.toContain('ada');
  });

  it('keeps the legacy page/nextPage contract', async () => {
    tx.emrPatient.findMany.mockResolvedValue(Array.from({ length: 26 }, (_, i) => ({ id: `p${i}`, dateOfBirth: new Date('1990-01-01'), createdAt: new Date() })));
    const response = await get(`${patients()}?page=1`);
    expect(response.body.data.items).toHaveLength(25);
    expect(response.body.data.nextPage).toBe(2);
    expect(response.body.data.items[0].dateOfBirth).toBe('1990-01-01');
  });

  it('UC-11: an update without If-Match is refused with 428 before touching the database', async () => {
    const response = await request(app).patch(`${patients()}/${patientId}`).set('Authorization', 'Bearer t').send({ phone: '+2348000000000' });
    expect(response.status).toBe(428);
    expect(response.body.error.code).toBe('PRECONDITION_REQUIRED');
    expect(tx.emrPatient.updateMany).not.toHaveBeenCalled();
  });

  it('rejects forged tenant fields and bad idempotency keys', async () => {
    const body = { givenName: 'Ada', familyName: 'Test', dateOfBirth: '1990-01-01', medicalRecordNumber: 'MRN-001' };
    const forged = await request(app).post(patients()).set('Authorization', 'Bearer t').send({ ...body, organizationId: orgB });
    expect(forged.status).toBe(400);
    expect(forged.body.error.details[0].message).toMatch(/unrecognized/i);
    const badKey = await request(app).post(patients()).set('Authorization', 'Bearer t').set('Idempotency-Key', 'short').send(body);
    expect(badKey.status).toBe(400);
  });

  it('never leaks internal error text', async () => {
    tx.emrPatient.findMany.mockRejectedValue(new Error('relation "secret_table" does not exist'));
    const response = await get(patients());
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('secret_table');
    expect(response.body.error.requestId).toBeTruthy();
  });

  it('refuses to open a tenant transaction for a malformed tenant id', async () => {
    await expect(withTenant({ organizationId: "x'; DROP TABLE emr_patients; --" }, async () => 1)).rejects.toThrow('TENANT_CONTEXT_MISSING');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe('crypto and webhook helpers', () => {
  it('encrypts webhook secrets with authenticated encryption', () => {
    const secret = newWebhookSecret();
    const sealed = encryptSecret(secret);
    expect(sealed).not.toContain(secret);
    expect(decryptSecret(sealed)).toBe(secret);
    const [v, iv, tag, body] = sealed.split('.');
    const tampered = [v, iv, tag, `${body.slice(0, -2)}AA`].join('.');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('signs payloads with a timestamped HMAC', () => {
    expect(signPayload('s', 1, '{}')).toBe(signPayload('s', 1, '{}'));
    expect(signPayload('s', 1, '{}')).not.toBe(signPayload('s', 2, '{}'));
  });

  it('backs off exponentially, capped, and gives up after MAX_ATTEMPTS', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(30)).toBe(6 * 60 * 60 * 1000);
    expect(MAX_ATTEMPTS).toBeGreaterThan(3);
  });

  it('only accepts public HTTPS webhook URLs', () => {
    expect(validateWebhookUrl('https://hooks.example.com/emr')).toBeNull();
    expect(validateWebhookUrl('http://hooks.example.com/emr')).toMatch(/HTTPS/);
    expect(validateWebhookUrl('https://127.0.0.1/x')).toMatch(/public/);
    expect(validateWebhookUrl('https://10.0.0.5/x')).toMatch(/public/);
    expect(validateWebhookUrl('https://localhost/x')).toMatch(/public/);
    expect(validateWebhookUrl('https://u:p@hooks.example.com/x')).toMatch(/credentials/);
  });

  it('hashes idempotent requests independent of key order', () => {
    expect(requestHash('s', { a: 1, b: { c: 2, d: 3 } })).toBe(requestHash('s', { b: { d: 3, c: 2 }, a: 1 }));
    expect(requestHash('s', { a: 1 })).not.toBe(requestHash('t', { a: 1 }));
  });
});
