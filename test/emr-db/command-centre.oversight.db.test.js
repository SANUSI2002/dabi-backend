// Command Centre oversight APIs against real Postgres: permissions, overview, patient 360 with
// reasons and emergency access, order trace, finance (refund maker-checker with provider evidence,
// settlements, reconciliation, webhooks), support cases, jobs and integrations, search and audit.
// All data is synthetic. The payment provider is never called for real: the one refund test
// replaces fetch with a stub that answers like Paystack's API.
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../../src/app.js';
import { auditFor } from '../../src/modules/audit/audit.service.js';
import { create as createOrder } from '../../src/modules/orders/orders.service.js';
import { tokenFor, prisma } from './fixtures.js';
import { ensureDeliveryKey, hold, marketplacePharmacy, north, person } from './commerce-fixtures.js';

const CC = '/api/v1/command-centre';
const as = (user) => ({
  get: (path) => request(app).get(`${CC}${path}`).set('Authorization', tokenFor(user.id)),
  post: (path, body = {}) => request(app).post(`${CC}${path}`).set('Authorization', tokenFor(user.id)).send(body),
});
const TEST_PAYSTACK_KEY = 'sk_test_synthetic_command_centre_only';
const signedWebhook = (event) => {
  const raw = JSON.stringify(event);
  return request(app).post('/api/v1/payments/paystack/webhook').set('Content-Type', 'application/json')
    .set('x-paystack-signature', createHmac('sha512', TEST_PAYSTACK_KEY).update(raw).digest('hex')).send(raw);
};

let admin; let support; let financeA; let financeB; let clinician; let patient; let outsider; let shop;

async function paidOrder(km = 3) {
  const to = north(shop.branch, km);
  const cart = await hold(patient, shop.listing);
  const { order } = await createOrder(patient.id, {
    reservationId: cart.id, idempotencyKey: randomUUID(), fulfilments: [{ pharmacyId: shop.pharmacy.id, fulfilmentMethod: 'DELIVERY' }],
    delivery: { recipientName: 'Synthetic Patient', recipientPhone: '+2348000000001', address: '7 Synthetic Avenue, Lagos', coordinates: to },
  });
  const attempt = await prisma.paymentAttempt.create({ data: { orderId: order.id, provider: 'PAYSTACK', idempotencyKey: randomUUID(), providerReference: `T-${randomUUID()}`, status: 'SUCCESS', amountMinor: order.totalPayableMinor, currency: 'NGN', expiresAt: new Date(Date.now() + 3_600_000), completedAt: new Date() } });
  await prisma.order.update({ where: { id: order.id }, data: { status: 'PAID' } });
  await prisma.orderFulfilment.updateMany({ where: { orderId: order.id }, data: { status: 'AWAITING_PHARMACIST_REVIEW' } });
  const fulfilment = await prisma.orderFulfilment.findFirst({ where: { orderId: order.id } });
  return { order, attempt, fulfilment };
}

beforeAll(async () => {
  ensureDeliveryKey();
  admin = await person('Ops Admin', { platformRoles: ['SABI_PLATFORM_ADMIN'] });
  support = await person('Support Agent', { platformRoles: ['SABI_SUPPORT'] });
  financeA = await person('Finance Maker', { platformRoles: ['SABI_FINANCE'] });
  financeB = await person('Finance Checker', { platformRoles: ['SABI_FINANCE'] });
  clinician = await person('Clinical Reviewer', { platformRoles: ['SABI_CLINICAL_OVERSIGHT'] });
  patient = await person('Oversight Patient', { role: 'PATIENT', phone: '+2348012345678' });
  outsider = await person('Not Staff', { role: 'PATIENT' });
  shop = await marketplacePharmacy({ unitPriceMinor: 200_000 });
  await prisma.userProfile.create({ data: { userId: patient.id, known_allergies: 'Penicillin (rash)', chronic_conditions: 'Asthma', consentGiven: true, consentGivenAt: new Date() } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PAYSTACK_SECRET_KEY;
});
// Other suites count active platform administrators; leave none of ours active.
afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.user.updateMany({ where: { platformRoleAssignments: { some: {} }, email: { endsWith: '@command.test' } }, data: { accountStatus: 'DISABLED' } });
});

describe('who can see what', () => {
  it('returns the caller’s roles and permissions, and enforces least privilege on the server', async () => {
    const me = await as(support).get('/me');
    expect(me.status).toBe(200);
    expect(me.body.data.roles).toEqual(['SABI_SUPPORT']);
    expect(me.body.data.permissions).toEqual(expect.arrayContaining(['platform.patients.read', 'platform.emergency.access']));
    expect(me.body.data.permissions).not.toContain('platform.finance.read');

    expect((await as(support).get('/finance/summary')).status).toBe(403);
    expect((await as(financeA).get('/patients')).status).toBe(403);
    expect((await as(outsider).get('/overview')).status).toBe(403);
    expect((await request(app).get(`${CC}/overview`)).status).toBe(401);
    expect((await as(admin).get('/overview')).headers['cache-control']).toBe('no-store');
  });
});

describe('overview', () => {
  it('reports live metrics with definitions and drill-downs for a period and time zone', async () => {
    await paidOrder();
    const res = await as(admin).get(`/overview?tz=Africa%2FLagos&from=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const metric = (key) => res.body.data.metrics.find((m) => m.key === key);
    expect(metric('ordersPaid').value).toBeGreaterThanOrEqual(1);
    expect(metric('ordersPaid')).toMatchObject({ unit: 'count', definition: expect.stringContaining('payment provider'), drill: { section: 'orders' } });
    expect(metric('grossMerchandiseValue').unit).toBe('kobo');
    expect(res.body.data.queues.map((q) => q.key)).toEqual(expect.arrayContaining(['refundsOpen', 'licencesExpiring', 'deadWebhooks']));
    expect(res.body.data.period.timeZone).toBe('Africa/Lagos');
    expect(res.body.data.daily.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.generatedAt).toBeTruthy();
    expect((await as(admin).get('/overview?tz=Mars%2FOlympus')).body.error.code).toBe('INVALID_TIME_ZONE');
  });
});

describe('patient 360', () => {
  it('lists patients with masked contact details', async () => {
    const res = await as(support).get(`/patients?q=${encodeURIComponent('Oversight')}`);
    expect(res.status).toBe(200);
    const row = res.body.data.items.find((p) => p.id === patient.id);
    expect(row.email).toMatch(/^o••••@command\.test$/);
    expect(row.phone).toBe('+234•••••5678');
    expect(JSON.stringify(res.body)).not.toContain(patient.email);
  });

  it('opens the account view only with a reason, audits it, tells the patient, and never invents a current location', async () => {
    expect((await as(support).post(`/patients/${patient.id}/account`, {})).status).toBe(400);
    const res = await as(support).post(`/patients/${patient.id}/account`, { reason: 'Patient called about a late delivery' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const view = res.body.data;
    expect(view.account).toMatchObject({ id: patient.id, email: patient.email });
    expect(view.location.current).toBeNull();
    expect(view.location.note).toMatch(/does not track/);
    expect(view.addresses[0]).toMatchObject({ address: '7 Synthetic Avenue, Lagos', source: expect.stringContaining('checkout'), recordedAt: expect.any(String) });
    expect(view.consents.platform.find((c) => c.key === 'termsAndPrivacy')).toMatchObject({ given: true, at: expect.any(String) });

    const entry = await prisma.auditEvent.findFirst({ where: { actorUserId: support.id, subjectUserId: patient.id, action: 'ADMIN_PATIENT_VIEWED' }, orderBy: { createdAt: 'desc' } });
    expect(entry.context).toMatchObject({ reason: 'Patient called about a late delivery', roles: ['SABI_SUPPORT'] });
    const seen = await auditFor(patient.id, { category: 'ADMIN' });
    expect(seen.items[0].text).toBe('Sabi staff opened your account details');

    const history = await as(admin).get(`/patients/${patient.id}/access-history?staffOnly=true`);
    expect(history.body.data.items[0]).toMatchObject({ action: 'ADMIN_PATIENT_VIEWED', reason: 'Patient called about a late delivery', byStaff: true });
  });

  it('keeps health information behind clinical permission or reviewed, time-limited emergency access', async () => {
    const denied = await as(support).post(`/patients/${patient.id}/clinical`, { reason: 'Patient asked about an allergy' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('EMERGENCY_ACCESS_REQUIRED');
    expect((await as(financeA).post(`/patients/${patient.id}/clinical`, { reason: 'Curious about this patient' })).status).toBe(403);

    expect((await as(support).post(`/patients/${patient.id}/emergency-access`, { reason: 'too short' })).status).toBe(400);
    const grant = await as(support).post(`/patients/${patient.id}/emergency-access`, { reason: 'Patient collapsed on a call; ambulance needs allergy list', minutes: 15 });
    expect(grant.status, JSON.stringify(grant.body)).toBe(201);

    const opened = await as(support).post(`/patients/${patient.id}/clinical`, { reason: 'Reading allergies to the ambulance crew' });
    expect(opened.status).toBe(200);
    expect(opened.body.data.access.kind).toBe('EMERGENCY');
    expect(opened.body.data.allergies.reported[0]).toMatchObject({ text: 'Penicillin (rash)', verification: 'UNVERIFIED', source: expect.stringContaining('self-reported') });
    expect(opened.body.data.medicines.purchased.length).toBeGreaterThan(0);
    expect(opened.body.data.medicines.definitions.handedOver).toBeTruthy();

    expect((await as(support).post(`/emergency-access/${grant.body.data.id}/review`, { outcome: 'APPROPRIATE', note: 'Support cannot review' })).status).toBe(403);
    expect((await as(admin).post(`/emergency-access/${grant.body.data.id}/review`, { outcome: 'APPROPRIATE', note: 'Genuine emergency' })).status).toBe(409);
    expect((await as(support).post(`/emergency-access/${grant.body.data.id}/end`)).status).toBe(200);
    expect((await as(support).post(`/patients/${patient.id}/clinical`, { reason: 'Looking again after the call' })).status).toBe(403);
    const reviewed = await as(admin).post(`/emergency-access/${grant.body.data.id}/review`, { outcome: 'APPROPRIATE', note: 'Genuine emergency, call log checked' });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.data).toMatchObject({ reviewOutcome: 'APPROPRIATE', reviewedByUserId: admin.id });

    const clinical = await as(clinician).post(`/patients/${patient.id}/clinical`, { reason: 'Quality review of medicine reconciliation' });
    expect(clinical.status).toBe(200);
    expect(clinical.body.data.access.kind).toBe('ROLE');
    const seen = await auditFor(patient.id, { category: 'ADMIN' });
    expect(seen.items.map((i) => i.text)).toEqual(expect.arrayContaining(['Sabi staff used emergency access to your health records', 'Sabi staff opened your health information']));
  });
});

describe('order trace', () => {
  it('shows one order end to end without delivery codes or the full patient contact', async () => {
    const { order, attempt } = await paidOrder();
    const res = await as(support).get(`/orders/${order.reference}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const trace = res.body.data;
    expect(trace.payments[0].providerReference).toBe(attempt.providerReference);
    expect(trace.fulfilments[0].deliveryQuote).toMatchObject({ pricingVersion: expect.any(Number), lines: expect.any(Array) });
    expect(trace.fulfilments[0].pharmacyEarningMinor).toBe(trace.fulfilments[0].subtotalMinor - trace.fulfilments[0].commissionMinor);
    expect(trace.timeline[0].text).toContain(order.reference);
    const text = JSON.stringify(trace);
    expect(text).not.toMatch(/CodeEncrypted|pickupCode|deliveryCode/);
    expect(text).not.toContain(patient.email);
    expect(text).not.toContain('7 Synthetic Avenue');

    const list = await as(admin).get(`/orders?q=${order.reference}`);
    expect(list.body.data.items[0].id).toBe(order.id);
  });
});

describe('finance', () => {
  it('runs a refund through maker-checker and only marks it refunded on provider evidence', async () => {
    const { order, attempt, fulfilment } = await paidOrder();
    const refundCase = await prisma.refundReviewCase.create({ data: { fulfilmentId: fulfilment.id, orderId: order.id, amountMinor: fulfilment.totalMinor, currency: 'NGN', reason: 'Pharmacy could not fulfil' } });
    const path = `/finance/refunds/${refundCase.id}`;

    expect((await as(support).post(`${path}/propose`, { note: 'Support cannot propose' })).status).toBe(403);
    expect((await as(financeA).post(`${path}/approve`, { note: 'Approve before proposal' })).status).toBe(409);
    expect((await as(financeA).post(`${path}/propose`, { note: 'Pharmacy out of stock, full refund' })).status).toBe(200);
    expect((await as(financeA).post(`${path}/approve`, { note: 'Approving my own proposal' })).body.error.code).toBe('SAME_PERSON');
    expect((await as(financeB).post(`${path}/approve`, { note: 'Checked the pharmacy rejection' })).status).toBe(200);

    const blocked = await as(financeA).post(`${path}/submit`);
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect((await prisma.refundReviewCase.findUnique({ where: { id: refundCase.id } })).status).toBe('APPROVED');

    process.env.PAYSTACK_SECRET_KEY = TEST_PAYSTACK_KEY;
    const fetchStub = vi.fn(async () => new globalThis.Response(JSON.stringify({ status: true, message: 'Refund has been queued for processing', data: { id: 987654, status: 'pending' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);
    const submitted = await as(financeA).post(`${path}/submit`);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.data).toMatchObject({ status: 'SUBMITTED', providerRefundReference: '987654', providerStatus: 'pending' });
    expect(JSON.parse(fetchStub.mock.calls[0][1].body)).toEqual({ transaction: attempt.providerReference, amount: fulfilment.totalMinor, currency: 'NGN' });
    expect((await as(financeA).post(`${path}/submit`)).status).toBe(409);

    const hook = await signedWebhook({ event: 'refund.processed', data: { id: 987654, status: 'processed', transaction_reference: attempt.providerReference, amount: fulfilment.totalMinor, currency: 'NGN' } });
    expect(hook.status).toBe(200);
    const done = await prisma.refundReviewCase.findUnique({ where: { id: refundCase.id } });
    expect(done).toMatchObject({ status: 'REFUNDED', providerStatus: 'processed' });
    expect(await prisma.paymentWebhookReceipt.findFirst({ where: { reference: attempt.providerReference, eventType: 'refund.processed' } })).toMatchObject({ outcome: 'APPLIED' });

    const forged = await request(app).post('/api/v1/payments/paystack/webhook').set('Content-Type', 'application/json').set('x-paystack-signature', 'bad').send('{}');
    expect(forged.status).toBe(401);
    const webhooks = await as(financeB).get('/finance/webhooks?outcome=REJECTED_SIGNATURE');
    expect(webhooks.body.data.total).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(webhooks.body)).not.toContain(TEST_PAYSTACK_KEY);
  });

  it('prepares, approves (by someone else) and records payment of a pharmacy settlement, idempotently', async () => {
    const { fulfilment } = await paidOrder();
    await prisma.orderFulfilment.update({ where: { id: fulfilment.id }, data: { status: 'DELIVERED' } });
    const periodStart = new Date(Date.now() - 86_400_000).toISOString();
    const periodEnd = new Date().toISOString();
    const body = { pharmacyId: shop.pharmacy.id, periodStart, periodEnd };

    const preview = await as(financeA).post('/finance/settlements/preview', body);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const line = preview.body.data.fulfilments.find((f) => f.id === fulfilment.id);
    expect(line.netMinor).toBe(fulfilment.subtotalMinor - fulfilment.commissionMinor);

    const key = randomUUID();
    const created = await as(financeA).post('/finance/settlements', { ...body, idempotencyKey: key });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.netPayableMinor).toBe(created.body.data.grossMinor - created.body.data.commissionMinor);
    const again = await as(financeA).post('/finance/settlements', { ...body, idempotencyKey: key });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ id: created.body.data.id, idempotent: true });
    expect((await as(financeA).post('/finance/settlements', { ...body, idempotencyKey: randomUUID() })).body.error.code).toBe('NOTHING_TO_SETTLE');

    const id = created.body.data.id;
    expect((await as(financeA).post(`/finance/settlements/${id}/paid`, { payoutReference: 'TRF-0001', note: 'Paid before approval' })).status).toBe(409);
    expect((await as(financeA).post(`/finance/settlements/${id}/approve`, { note: 'Approving my own' })).body.error.code).toBe('SAME_PERSON');
    expect((await as(financeB).post(`/finance/settlements/${id}/approve`, { note: 'Totals checked against orders' })).status).toBe(200);
    const paid = await as(financeB).post(`/finance/settlements/${id}/paid`, { payoutReference: 'TRF-2026-10-0001', note: 'Bank transfer from operating account' });
    expect(paid.body.data).toMatchObject({ status: 'PAID', payoutReference: 'TRF-2026-10-0001' });
    const trace = await as(admin).get(`/orders/${fulfilment.orderId}`);
    expect(trace.body.data.fulfilments[0].settlement).toMatchObject({ id, status: 'PAID' });
  });

  it('flags reconciliation mismatches with what should be true', async () => {
    const { order } = await paidOrder();
    await prisma.paymentAttempt.updateMany({ where: { orderId: order.id }, data: { status: 'FAILED' } });
    const res = await as(financeA).get('/finance/reconciliation');
    expect(res.status).toBe(200);
    const check = res.body.data.checks.find((c) => c.key === 'paid-without-success');
    expect(check).toMatchObject({ status: 'MISMATCH', expectation: expect.any(String), severity: 'critical' });
    expect(check.items.map((i) => i.id)).toContain(order.id);
    const summary = await as(financeA).get('/finance/summary');
    expect(summary.body.data.breakdown.sabiRevenueMinor).toBe(summary.body.data.breakdown.commissionMinor + summary.body.data.breakdown.deliveryFeesMinor + summary.body.data.breakdown.platformFeesMinor);
  });
});

describe('support cases', () => {
  it('opens a case with an SLA, refuses stale or unresolved updates, and keeps an append-only history', async () => {
    const created = await as(support).post('/cases', { kind: 'SUPPORT', category: 'DELIVERY', priority: 'P2', title: 'Delivery is late', description: 'Patient says the rider has not arrived after two hours.', subjectUserId: patient.id, assigneeUserId: support.id });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const c = created.body.data;
    expect(c.reference).toMatch(/^CASE-/);
    expect(new Date(c.dueAt).getTime() - new Date(c.createdAt).getTime()).toBe(24 * 3_600_000);

    expect((await as(support).post(`/cases/${c.id}/update`, { version: c.version, status: 'RESOLVED' })).body.error.code).toBe('RESOLUTION_REQUIRED');
    const progressed = await as(support).post(`/cases/${c.id}/update`, { version: c.version, status: 'IN_PROGRESS', note: 'Called the rider' });
    expect(progressed.status).toBe(200);
    expect((await as(support).post(`/cases/${c.id}/update`, { version: c.version, note: 'Stale write' })).body.error.code).toBe('STALE');
    const resolved = await as(support).post(`/cases/${c.id}/update`, { version: progressed.body.data.version, status: 'RESOLVED', resolution: 'Rider delivered at 14:20; patient confirmed.' });
    expect(resolved.body.data.status).toBe('RESOLVED');

    const detail = await as(admin).get(`/cases/${c.id}`);
    expect(detail.body.data.events.map((e) => e.kind)).toEqual(['CREATED', 'STATUS', 'NOTE', 'STATUS']);
    await expect(prisma.opsCaseEvent.deleteMany({ where: { caseId: c.id } })).rejects.toThrow(/append-only/);
    expect((await as(financeA).post('/cases', { kind: 'SUPPORT', category: 'OTHER', priority: 'P4', title: 'Not allowed', description: 'Finance cannot open cases.' })).status).toBe(403);
  });
});

describe('jobs, integrations and alerts', () => {
  it('retries failed jobs only where a late send is safe, and never exposes secrets', async () => {
    const note = await prisma.notification.create({ data: { userId: patient.id, title: 'Order update', message: 'Synthetic', category: 'ORDER', eventType: 'order.updated' } });
    const failed = await prisma.notificationDelivery.create({ data: { notificationId: note.id, userId: patient.id, channel: 'WHATSAPP', status: 'FAILED', attempts: 3, lastError: 'Synthetic provider failure' } });
    const list = await as(admin).get('/ops/jobs?type=notification&status=FAILED');
    const row = list.body.data.items.find((r) => r.id === failed.id);
    expect(row).toMatchObject({ retryable: true, category: 'ORDER', eventType: 'order.updated' });
    expect(JSON.stringify(row)).not.toContain('Order update');

    expect((await as(support).post(`/ops/jobs/notification/${failed.id}/retry`, { reason: 'WhatsApp outage fixed' })).status).toBe(403);
    const retried = await as(admin).post(`/ops/jobs/notification/${failed.id}/retry`, { reason: 'WhatsApp outage fixed' });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(await prisma.notificationDelivery.findUnique({ where: { id: failed.id } })).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect((await as(admin).post(`/ops/jobs/reminder/${randomUUID()}/retry`, { reason: 'Try a reminder' })).body.error.code).toBe('NOT_RETRYABLE');

    process.env.PAYSTACK_SECRET_KEY = TEST_PAYSTACK_KEY;
    const integrations = await as(admin).get('/ops/integrations');
    expect(integrations.body.data.items.find((i) => i.key === 'paystack').status).toMatch(/CONFIGURED|DEGRADED/);
    expect(JSON.stringify(integrations.body)).not.toContain(TEST_PAYSTACK_KEY);
    expect(JSON.stringify(integrations.body)).not.toContain(process.env.ORDER_DELIVERY_ENCRYPTION_KEY);
    const alerts = await as(admin).get('/ops/alerts');
    expect(alerts.status).toBe(200);
    expect(alerts.body.data.items.every((a) => ['critical', 'warning', 'info'].includes(a.severity))).toBe(true);
    const summary = await as(admin).get('/ops/jobs/summary');
    expect(summary.body.data.types['emr-webhook'].outbox).toBeDefined();
  });
});

describe('providers and consultations', () => {
  it('suspends and reinstates a doctor only with a reason, and lists expiring credentials', async () => {
    const doctor = await person('Synthetic Doctor', { role: 'PROFESSIONAL' });
    const profile = await prisma.professionalProfile.create({ data: { userId: doctor.id, professionType: 'DOCTOR', registrationNumber: `MDCN-${randomUUID().slice(0, 6)}`, verificationStatus: 'VERIFIED' } });
    await prisma.doctorApplication.create({ data: { professionalId: profile.id, details: { licenceType: 'annual', licenceExpiry: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10) }, consentVersion: 'test', stage: 'APPROVED' } });

    const expiring = await as(admin).get('/providers/credentials?within=30&kind=doctor');
    expect(expiring.body.data.items.find((i) => i.id === profile.id)).toMatchObject({ state: 'EXPIRING', daysLeft: expect.any(Number) });

    expect((await as(admin).post(`/providers/doctors/${profile.id}/suspend`, {})).status).toBe(400);
    expect((await as(support).post(`/providers/doctors/${profile.id}/suspend`, { reason: 'Complaint under investigation' })).status).toBe(403);
    const suspended = await as(admin).post(`/providers/doctors/${profile.id}/suspend`, { reason: 'Complaint under investigation (CASE-123)' });
    expect(suspended.body.data.verificationStatus).toBe('SUSPENDED');
    expect((await as(admin).post(`/providers/doctors/${profile.id}/suspend`, { reason: 'Suspend twice' })).status).toBe(409);
    expect((await as(admin).post(`/providers/doctors/${profile.id}/reinstate`, { reason: 'Investigation closed, no fault' })).body.data.verificationStatus).toBe('VERIFIED');
    const audit = await prisma.auditEvent.findMany({ where: { resourceType: 'professional_profile', resourceId: profile.id }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.context.after.verificationStatus)).toEqual(['SUSPENDED', 'VERIFIED']);

    const consultations = await as(admin).get('/consultations?attention=unsigned-note');
    expect(consultations.status).toBe(200);
  });
});

describe('search and audit', () => {
  it('searches across products within the caller’s permissions', async () => {
    const { order } = await paidOrder();
    const found = await as(admin).get(`/search?q=${encodeURIComponent(order.reference)}`);
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body.data.groups.find((g) => g.type === 'order').items[0].id).toBe(order.id);
    const financeSearch = await as(financeA).get('/search?q=Oversight');
    expect(financeSearch.status, JSON.stringify(financeSearch.body)).toBe(200);
    expect(financeSearch.body.data.groups.find((g) => g.type === 'patient')).toBeUndefined();
  });

  it('filters the audit trail and exports it as CSV, which is itself audited', async () => {
    const list = await as(admin).get(`/audit?category=ADMIN&subjectUserId=${patient.id}`);
    expect(list.status).toBe(200);
    expect(list.body.data.items.length).toBeGreaterThan(0);
    expect(list.body.data.appendOnly).toBe(true);

    expect((await as(admin).post('/audit/export', { filters: { category: 'ADMIN' } })).status).toBe(400);
    const csv = await as(admin).post('/audit/export', { reason: 'Quarterly access review', filters: { category: 'ADMIN', subjectUserId: patient.id } });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toBe('time,category,action,summary,actor,actor_id,subject,subject_id,resource_type,resource_id,reason,before,after,device,ip_masked,location');
    expect(await prisma.auditEvent.findFirst({ where: { actorUserId: admin.id, action: 'ADMIN_EXPORT' } })).toMatchObject({ context: expect.objectContaining({ reason: 'Quarterly access review' }) });
    expect((await as(support).post('/audit/export', { reason: 'Support wants an export', filters: {} })).status).toBe(403);
  });
});

describe('every Command Centre screen answers', () => {
  it('serves each read endpoint to a super admin without errors', async () => {
    const root = await person('Super Admin', { platformRoles: ['SABI_SUPER_ADMIN'] });
    const { order, fulfilment } = await paidOrder();
    const doctor = await person('Listed Doctor', { role: 'PROFESSIONAL' });
    const profile = await prisma.professionalProfile.create({ data: { userId: doctor.id, professionType: 'DOCTOR', registrationNumber: `MDCN-${randomUUID().slice(0, 6)}`, verificationStatus: 'VERIFIED' } });
    const slot = await prisma.doctorAvailabilitySlot.create({ data: { doctorProfileId: profile.id, startsAt: new Date(Date.now() - 7_200_000), endsAt: new Date(Date.now() - 5_400_000) } }).catch(() => null);
    const appointment = slot ? await prisma.doctorAppointment.create({ data: { patientId: patient.id, doctorProfileId: profile.id, slotId: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt, consultationType: 'VIRTUAL', status: 'COMPLETED', completedAt: new Date() } }) : null;
    const paths = [
      '/me', '/overview', '/patients', `/patients/${patient.id}/access-history`, '/emergency-access', '/emergency-access?unreviewed=true',
      '/orders', `/orders/${order.id}`, '/deliveries', '/deliveries?state=UNASSIGNED', '/consultations', '/consultations?attention=overdue-confirmation',
      ...(appointment ? [`/consultations/${appointment.id}`] : []),
      '/providers/credentials', '/providers/summary', '/finance/summary', '/finance/payments', '/finance/payments?status=FAILED', '/finance/webhooks', '/finance/reconciliation',
      '/finance/refunds', '/finance/refunds?status=OPEN', '/finance/settlements', '/cases', '/cases?status=ACTIVE&assignee=me', '/cases/meta/assignees',
      '/ops/integrations', '/ops/jobs/summary', '/ops/jobs?type=notification', '/ops/jobs?type=reminder', '/ops/jobs?type=pharmacy-email', '/ops/jobs?type=emr-webhook', '/ops/alerts',
      '/audit', '/search?q=Synthetic', '/pricing/delivery',
    ];
    for (const path of paths) {
      const res = await as(root).get(path);
      expect(res.status, `${path}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    }
    if (appointment) {
      const detail = await as(root).get(`/consultations/${appointment.id}`);
      expect(detail.body.data.note).toEqual({ started: false, signed: false });
      expect(JSON.stringify(detail.body)).not.toContain('reason":"');
    }
    expect(fulfilment.id).toBeTruthy();
  });

  it('dispatches a rider to a ready delivery with a reason, once', async () => {
    const { order, fulfilment } = await paidOrder();
    const riderUser = await person('Synthetic Rider', { role: 'DELIVERY_PARTNER' });
    const rider = await prisma.deliveryPartner.create({ data: { userId: riderUser.id, displayName: 'Rider One', isActive: true, configuredByUserId: admin.id } });
    const path = `/deliveries/${fulfilment.id}/assign`;
    const early = await as(admin).post(path, { partnerId: rider.id, reason: 'Pharmacy has not assigned a rider' });
    expect(early.status).toBe(409);
    expect(early.body.error.details.blockers[0]).toMatch(/ready for pickup/);
    await prisma.orderFulfilment.update({ where: { id: fulfilment.id }, data: { status: 'READY_FOR_PICKUP', inventoryFinalizedAt: new Date() } });
    expect((await as(support).post(path, { partnerId: rider.id, reason: 'Support cannot dispatch' })).status).toBe(403);
    const assigned = await as(admin).post(path, { partnerId: rider.id, reason: 'Pharmacy has not assigned a rider for 30 minutes' });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
    expect((await as(admin).post(path, { partnerId: rider.id, reason: 'Assign a second time' })).status).toBe(409);
    const board = await as(admin).get('/deliveries?state=ASSIGNED');
    expect(board.body.data.items.find((i) => i.fulfilmentId === fulfilment.id).assignment.rider).toBe('Rider One');
    const trace = await as(admin).get(`/orders/${order.id}`);
    expect(trace.body.data.timeline.map((e) => e.text).join('\n')).toMatch(/assigned to rider Rider One/);
  });

  it('signs a patient out everywhere with a reason', async () => {
    const device = await prisma.authDevice.create({ data: { userId: patient.id, label: 'Synthetic phone' } });
    await prisma.authSession.create({ data: { userId: patient.id, deviceId: device.id, expiresAt: new Date(Date.now() + 86_400_000) } });
    expect((await as(support).post(`/patients/${patient.id}/sessions/revoke`, { reason: 'Patient reported a lost phone' })).status).toBe(403);
    const res = await as(admin).post(`/patients/${patient.id}/sessions/revoke`, { reason: 'Patient reported a lost phone' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect(await prisma.authSession.count({ where: { userId: patient.id, revokedAt: null } })).toBe(0);
  });
});
