import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../../src/app.js';
import { prisma, createTenant, tokenFor } from './fixtures.js';
import { person } from './commerce-fixtures.js';
import * as billing from '../../src/modules/command-centre/subscriptions.service.js';
import { sendSubscriptionMail } from '../../src/modules/command-centre/runtime.worker.js';
let hospital, foreign, admin, outsider;
const CC = '/api/v1/command-centre/runtime';
const req = () => ({ user: { id: admin.id }, accessContext: { roles: ['SABI_PLATFORM_ADMIN'] }, headers: {} });
const post = (path, body, user = admin) => request(app).post(`${CC}${path}`).set('Authorization', tokenFor(user.id)).send(body);
const put = (path, body, user = admin) => request(app).put(`${CC}${path}`).set('Authorization', tokenFor(user.id)).send(body);
beforeAll(async () => {
  hospital = await createTenant('Subscription'), foreign = await createTenant('OtherSubscription');
  admin = await person('Settings Operator', { platformRoles: ['SABI_PLATFORM_ADMIN'] });
  outsider = await person('Not Operations', { role: 'PATIENT' });
  const pkg = await prisma.platformPackage.create({ data: { code: `SUB-${randomUUID().slice(0, 8)}`, name: 'Synthetic paid hospital package', description: 'Synthetic subscription test' } });
  const version = await prisma.platformPackageVersion.create({ data: { packageId: pkg.id, version: 1, status: 'PUBLISHED', monthlyPriceMinor: 2500000, annualPriceMinor: 25000000, currency: 'NGN', moduleKeys: ['emr'], createdByUserId: admin.id, publishedAt: new Date() } });
  await prisma.platformApplication.updateMany({ where: { approvedOrganisationId: hospital.facilityId }, data: { packageId: pkg.id, packageVersionId: version.id } });
});
const invoice = (periodStart = '2027-01-31') => billing.createSubscriptionInvoice(req(), { organizationId: hospital.organizationId, requestKey: randomUUID(), periodStart, dueAt: periodStart, reason: 'Synthetic subscription billing acceptance.' });
describe('Server-owned settings and tenant presentation', () => {
  it('enforces role, safe schemas, optimistic concurrency, contrast and tenant scope', async () => {
    expect((await put('/settings', {}, outsider)).status).toBe(403);
    const current = (await request(app).get(`${CC}/settings`).set('Authorization', tokenFor(admin.id))).body.data;
    const values = { expectedVersion: current.version, supportEmail: 'support@sabihealth.org', infoEmail: 'info@sabihealth.org', trackingRetentionDays: 30, reason: 'Synthetic settings version check.' };
    expect((await put('/settings', values)).status).toBe(200);
    expect((await put('/settings', values)).status).toBe(409);
    expect((await put('/settings', { ...values, trackingRetentionDays: 0 })).status).toBe(400);
    const theme = { expectedVersion: 0, displayName: 'Synthetic Hospital Workspace', tagline: 'Synthetic tenant care', accentColor: '#065f46', reason: 'Synthetic hospital presentation check.' };
    expect((await put(`/presentation/${hospital.organizationId}`, { ...theme, accentColor: '#ffffff' })).status).toBe(400);
    expect((await put(`/presentation/${hospital.organizationId}`, theme)).status).toBe(200);
    expect((await put(`/presentation/${hospital.organizationId}`, theme)).status).toBe(409);
    const result = await request(app).get(`/api/v1/emr/organizations/${hospital.organizationId}/runtime/presentation`).set('Authorization', hospital.auth);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data.presentation.displayName).toBe(theme.displayName);
    const cross = await request(app).get(`/api/v1/emr/organizations/${hospital.organizationId}/runtime/presentation`).set('Authorization', foreign.auth);
    expect(cross.status).toBe(403);
    expect((await request(app).get('/api/v1/public/runtime/contact')).body.data.supportEmail).toBe(values.supportEmail);
  });
});
describe('Subscription invoices and independent payment verification', () => {
  it('uses the accepted price, clamps month ends, prevents overlapping periods and never debits automatically', async () => {
    expect(billing.periodEnd(new Date('2028-02-29T00:00:00Z'), 'annual').toISOString().slice(0, 10)).toBe('2029-02-28');
    const data = { organizationId: hospital.organizationId, requestKey: randomUUID(), periodStart: '2027-01-31', dueAt: '2027-02-05', reason: 'Synthetic accepted-package invoice.' };
    const response = await post('/subscription-invoices', data);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({ amountMinor: 2500000, currency: 'NGN', status: 'OPEN', periodEnd: '2027-02-28T00:00:00.000Z', payment: null });
    expect((await post('/subscription-invoices', data)).body.data.id).toBe(response.body.data.id);
    expect((await post('/subscription-invoices', { ...data, requestKey: randomUUID(), periodStart: '2027-02-01' })).status).toBe(409);
    expect((await post('/subscription-invoices', { ...data, requestKey: randomUUID(), amountMinor: 1 })).status).toBe(400);
    await expect(prisma.subscriptionInvoice.update({ where: { id: response.body.data.id }, data: { amountMinor: 1 } })).rejects.toThrow();
    expect(await prisma.subscriptionEmailJob.count({ where: { invoiceId: response.body.data.id } })).toBe(1);
    const list = await request(app).get(`/api/v1/emr/organizations/${hospital.organizationId}/runtime/subscription`).set('Authorization', hospital.auth);
    expect(list.status, JSON.stringify(list.body)).toBe(200); expect(list.body.data.items[0].id).toBe(response.body.data.id);
    expect((await request(app).get(`/api/v1/emr/organizations/${hospital.organizationId}/runtime/subscription`).set('Authorization', foreign.auth)).status).toBe(403);
  });
  it('freezes one checkout reference, blocks double initialization and verifies amount/currency before payment', async () => {
    const issued = await invoice('2027-03-01');
    const initializeCharge = vi.fn(async ({ reference }) => ({ reference, authorization_url: 'https://checkout.paystack.com/synthetic' }));
    const gateway = { operationsConfigured: () => true, initializeCharge };
    const started = await billing.startSubscriptionPayment(hospital.organizationId, issued.id, { gateway });
    expect((await billing.startSubscriptionPayment(hospital.organizationId, issued.id, { gateway })).reference).toBe(started.reference);
    expect(initializeCharge).toHaveBeenCalledTimes(1);
    await expect(billing.startSubscriptionPayment(foreign.organizationId, issued.id, { gateway })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(billing.voidSubscriptionInvoice(req(), issued.id, 'Cannot void an active checkout.')).rejects.toMatchObject({ code: 'INVOICE_NOT_VOIDABLE' });
    const result = { reference: started.reference, currency: 'NGN', amount: issued.amountMinor, status: 'success' };
    await billing.subscriptionWebhook({ event: 'charge.success', data: result });
    expect((await prisma.subscriptionInvoice.findUnique({ where: { id: issued.id } })).status).toBe('OPEN');
    await expect(billing.reconcileSubscription(started.reference, { gateway: { verifyCharge: async () => ({ ...result, amount: 1 }) } })).rejects.toMatchObject({ code: 'PROVIDER_MISMATCH' });
    const paid = await billing.reconcileSubscription(started.reference, { gateway: { verifyCharge: async () => result } });
    expect(paid.status).toBe('PAID');
    expect((await billing.reconcileSubscription(started.reference, { gateway: { verifyCharge: async () => result } })).paidAt).toEqual(paid.paidAt);
    expect(await prisma.subscriptionEmailJob.count({ where: { invoiceId: issued.id, kind: 'PAID' } })).toBe(1);
  });
  it('keeps timeouts uncertain, rejects unsafe checkout URLs and voids only untouched invoices', async () => {
    const uncertain = await invoice('2027-04-01');
    const initializeCharge = vi.fn(async () => { throw Object.assign(new Error('Synthetic timeout'), { uncertain: true }); });
    const gateway = { operationsConfigured: () => true, initializeCharge };
    await expect(billing.startSubscriptionPayment(hospital.organizationId, uncertain.id, { gateway })).rejects.toThrow();
    await expect(billing.startSubscriptionPayment(hospital.organizationId, uncertain.id, { gateway })).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });
    expect(initializeCharge).toHaveBeenCalledTimes(1);
    const unsafe = await invoice('2027-05-01');
    await expect(billing.startSubscriptionPayment(hospital.organizationId, unsafe.id, { gateway: { operationsConfigured: () => true, initializeCharge: async ({ reference }) => ({ reference, authorization_url: 'https://attacker.test' }) } })).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    const untouched = await invoice('2027-06-01');
    expect((await billing.voidSubscriptionInvoice(req(), untouched.id, 'Synthetic unused period cancellation.')).status).toBe('VOID');
    await expect(billing.startSubscriptionPayment(hospital.organizationId, untouched.id, { gateway })).rejects.toMatchObject({ code: 'INVOICE_NOT_OPEN' });
  });
  it('sends durable emails with a fixed idempotency key and no clinical details', async () => {
    process.env.RESEND_API_KEY = 'synthetic'; process.env.PASSWORD_RESET_EMAIL_FROM = 'Sabi <no-reply@sabihealth.org>';
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'synthetic-receipt' }) }));
    try {
      expect(await sendSubscriptionMail({ fetcher })).toBe(true);
      const options = fetcher.mock.calls[0][1];
      expect(options.headers['Idempotency-Key']).toMatch(/^subscription-mail-/);
      expect(options.body).not.toMatch(/patientId|medicalRecord|password:/);
    } finally { delete process.env.RESEND_API_KEY; delete process.env.PASSWORD_RESET_EMAIL_FROM; }
  });
  it('never sends a queued invoice email to a disabled or changed owner', async () => {
    const issued = await invoice('2027-07-01');
    await prisma.subscriptionEmailJob.updateMany({ where: { status: 'QUEUED', invoiceId: { not: issued.id } }, data: { status: 'FAILED' } });
    await prisma.user.update({ where: { id: hospital.userId }, data: { accountStatus: 'DISABLED' } });
    process.env.RESEND_API_KEY = 'synthetic'; process.env.PASSWORD_RESET_EMAIL_FROM = 'Sabi <no-reply@sabihealth.org>';
    const fetcher = vi.fn();
    try {
      await sendSubscriptionMail({ fetcher });
      expect(fetcher).not.toHaveBeenCalled();
      expect((await prisma.subscriptionEmailJob.findUnique({ where: { invoiceId_kind: { invoiceId: issued.id, kind: 'ISSUED' } } })).lastErrorCode).toBe('RECIPIENT_CHANGED');
    } finally { delete process.env.RESEND_API_KEY; delete process.env.PASSWORD_RESET_EMAIL_FROM; }
  });
});
