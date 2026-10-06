import express from 'express';
import { Buffer } from 'node:buffer';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const owner = '11111111-1111-4111-8111-111111111111', reviewer = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333', professionalId = '44444444-4444-4444-8444-444444444444', credentialId = '55555555-5555-4555-8555-555555555555';
const db = { user: { create: vi.fn() }, professionalProfile: { create: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() }, doctorApplication: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() }, doctorCredential: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() }, activityLog: { create: vi.fn() }, notification: {create: vi.fn()}, $queryRaw: vi.fn(), $transaction: vi.fn() };
const authModel = { createEmailVerificationToken: vi.fn(), revokeOtherEmailVerificationTokens: vi.fn(), revokeEmailVerificationToken: vi.fn(), findUserByEmail: vi.fn(), latestEmailVerificationToken: vi.fn(), confirmEmailVerificationToken: vi.fn() };
const getBucket = vi.fn(), storageUpload = vi.fn(), signed = vi.fn(), remove = vi.fn();
const client = { storage: { getBucket, from: () => ({ upload: storageUpload, remove, createSignedUrl: signed }) } };
vi.mock('../src/config/db.js', () => ({ default: db }));
vi.mock('bcryptjs', () => ({ default: { hash: async () => 'HASH_ONLY_NOT_PASSWORD' } }));
vi.mock('../src/modules/auth/auth.model.js', () => authModel);
vi.mock('../src/config/privateStorage.js', async (original) => ({ ...await original(), privateStorageClient: () => client }));
vi.mock('../src/middleware/accessMiddleware.js', () => ({
  requirePlatform: (req, res, next) => req.get('X-Test-Platform') === 'true' ? next() : res.sendStatus(403),
  requirePermission: (code) => (req, res, next) => code.endsWith('approve') && req.get('X-Test-Approve') !== 'true' ? res.sendStatus(403) : next(),
}));
// Fail-closed MFA is exercised independently of the legacy no-sid fixtures.
vi.mock('../src/middleware/mfaMiddleware.js', () => ({ requireRecentMfa: (req, res, next) => req.get('X-Test-Mfa') === 'true' ? next() : res.status(403).json({ message: 'Recent multi-factor verification is required.' }) }));
const { doctorOnboardingRoutes, platformDoctorRoutes } = await import('../src/modules/doctors/onboarding.routes.js');
const app = express(); app.use(express.json()); app.use('/doctors', doctorOnboardingRoutes); app.use('/platform/doctors', platformDoctorRoutes);
const headers = (userId = owner) => ({ Authorization: `Bearer ${jwt.sign({ userId }, 'doctor-onboarding-test')}` });
const staff = (userId = reviewer) => ({ ...headers(userId), 'X-Test-Platform': 'true', 'X-Test-Mfa': 'true', 'X-Test-Approve': 'true' });
const bytes = Buffer.from('%PDF-1.7\nsynthetic');
let profile, application;
const credential = (kind, extra = {}) => ({ id: kind === 'licence' ? credentialId : '66666666-6666-4666-8666-666666666666', kind, createdAt: new Date(), scanStatus: 'CLEAN', storageBucket: 'sabi-hospital-evidence-clean', storageKey: 'synthetic.pdf', byteSize: bytes.length, contentType: 'application/pdf', sha256: 'f'.repeat(64), reviewStatus: 'VERIFIED', ...extra });
const body = { firstName: 'Synthetic', lastName: 'Doctor', email: 'synthetic@example.test', phone: '+2348012345678', password: 'Synthetic long passphrase', specialty: 'General Practice', qualification: 'MBBS', university: 'Synthetic University', graduationYear: 2010, registrationNumber: 'TEST-001', practiceState: 'Lagos', city: 'Lagos', licenceType: 'life', declaration: true, termsAccepted: true, country: 'NG', regulator: 'MDCN', consentVersion: 'doctor-registration-v1' };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('JWT_SECRET', 'doctor-onboarding-test'); vi.stubEnv('DOCTOR_REGISTRATION_ENABLED', 'true'); vi.stubEnv('EVIDENCE_SCANNER_ENABLED', 'true'); vi.stubEnv('EVIDENCE_SCANNER_PROVIDER', 'cloudmersive'); vi.stubEnv('CLOUDMERSIVE_API_KEY', 'synthetic-key'); vi.stubEnv('CLOUDMERSIVE_CREDENTIAL_PROCESSING_APPROVED', 'true'); vi.stubEnv('RESEND_API_KEY', 'synthetic-key'); vi.stubEnv('PASSWORD_RESET_EMAIL_FROM', 'no-reply@sabihealth.org');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  application = { id, professionalId, submittedAt: new Date(), details: { licenceType: 'life' }, credentials: [credential('licence'), credential('registrationCertificate')] };
  profile = { id: professionalId, userId: owner, professionType: 'DOCTOR', verificationStatus: 'PENDING', user: { id: owner, full_name: 'Synthetic Doctor', email: body.email, accountStatus: 'ACTIVE', emailVerifiedAt: new Date() }, doctorApplication: application };
  application.professional = profile;
  db.$transaction.mockImplementation(async (work) => work(db)); db.$queryRaw.mockResolvedValue([{ id }]);
  db.doctorApplication.findUnique.mockImplementation(async () => application);
  db.professionalProfile.findUnique.mockImplementation(async () => profile); db.professionalProfile.findFirst.mockImplementation(async () => profile); db.professionalProfile.findMany.mockResolvedValue([]);
  db.professionalProfile.update.mockImplementation(async ({ data }) => ({ ...profile, ...data }));
  db.user.create.mockResolvedValue({ id: owner, email: body.email }); db.professionalProfile.create.mockResolvedValue(profile); db.activityLog.create.mockResolvedValue({});
  db.doctorCredential.create.mockImplementation(async ({ data }) => ({ id: credentialId, createdAt: new Date(), scanStatus: 'PENDING', reviewStatus: 'PENDING', ...data }));
  getBucket.mockResolvedValue({ data: { public: false } }); storageUpload.mockImplementation(async (path) => ({ data: { path } })); remove.mockResolvedValue({}); signed.mockResolvedValue({ data: { signedUrl: 'https://synthetic.supabase.co/storage/v1/object/sign/synthetic.pdf' } });
  authModel.createEmailVerificationToken.mockResolvedValue({ id: 'verification-id' }); authModel.confirmEmailVerificationToken.mockResolvedValue(true); authModel.findUserByEmail.mockResolvedValue(null);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('doctor credential lifecycle', () => {
  it('creates a pending account with a hashed password, no upload capability and a single-use canonical email link', async () => {
    const response = await request(app).post('/doctors/register').send(body);
    expect(response.status).toBe(201); expect(response.body.data.emailSent).toBe(true); expect(response.body.data.uploadToken).toBeUndefined();
    expect(db.user.create.mock.calls[0][0].data).toMatchObject({ accountStatus: 'PENDING', password: 'HASH_ONLY_NOT_PASSWORD' });
    expect(db.professionalProfile.create.mock.calls[0][0].data.doctorApplication.create.details.password).toBeUndefined();
    const mail = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(mail.text).toContain('https://telemedicine.sabihealth.org/doctor-portal/verify-email/'); expect(mail.text).not.toContain(body.password);
    expect(authModel.createEmailVerificationToken.mock.calls[0][1]).toMatch(/^[a-f0-9]{64}$/);
  });
  it('does not create an account when intake is disabled or storage is public', async () => {
    vi.stubEnv('DOCTOR_REGISTRATION_ENABLED', 'false'); expect((await request(app).post('/doctors/register').send(body)).status).toBe(503);
    vi.stubEnv('DOCTOR_REGISTRATION_ENABLED', 'true'); getBucket.mockResolvedValue({ data: { public: true } }); expect((await request(app).post('/doctors/register').send(body)).status).toBe(503);
    expect(db.user.create).not.toHaveBeenCalled();
  });
  it('reports email delivery failure without duplicating or falsely approving the account', async () => {
    globalThis.fetch.mockResolvedValue({ ok: false, status: 429 }); const response = await request(app).post('/doctors/register').send(body);
    expect(response.status).toBe(201); expect(response.body.data.emailSent).toBe(false); expect(authModel.revokeEmailVerificationToken).toHaveBeenCalled();
  });
  it('consumes a doctor verification token, rejects invalid/reused tokens and does not approve credentials', async () => {
    expect((await request(app).post('/doctors/verify-email').send({ uid: owner, token: 'a'.repeat(64) })).status).toBe(200);
    authModel.confirmEmailVerificationToken.mockResolvedValue(false);
    expect((await request(app).post('/doctors/verify-email').send({ uid: owner, token: 'a'.repeat(64) })).status).toBe(400);
    db.professionalProfile.findUnique.mockResolvedValue({ professionType: 'NURSE' });
    expect((await request(app).post('/doctors/verify-email').send({ uid: owner, token: 'a'.repeat(64) })).status).toBe(400);
    expect(db.professionalProfile.update).not.toHaveBeenCalled();
  });
  it('requires an authenticated, email-verified owner before uploading', async () => {
    const path = `/doctors/applications/${id}/credentials/licence`;
    expect((await request(app).put(path).type('application/pdf').send(bytes)).status).toBe(401);
    expect((await request(app).put(path).set(headers(reviewer)).type('application/pdf').send(bytes)).status).toBe(403);
    profile.user.emailVerifiedAt = null;
    expect((await request(app).put(path).set(headers()).type('application/pdf').send(bytes)).status).toBe(403);
    expect(storageUpload).not.toHaveBeenCalled();
  });
  it('uploads an immutable quarantined object and invalidates prior submission', async () => {
    const response = await request(app).put(`/doctors/applications/${id}/credentials/licence`).set(headers()).type('application/pdf').send(bytes);
    expect(response.status).toBe(201); expect(response.body.data.scanStatus).toBe('PENDING'); expect(response.body.data.storageKey).toBeUndefined();
    expect(storageUpload.mock.calls[0][2].upsert).toBe(false); expect(db.doctorApplication.update).toHaveBeenCalledWith({ where: { id }, data: { submittedAt: null, stage: 'DRAFT' } });
  });
  it('rejects malformed, oversized and unsupported documents without storing content', async () => {
    const path = `/doctors/applications/${id}/credentials/licence`;
    expect((await request(app).put(path).set(headers()).type('application/pdf').send(Buffer.from('not a PDF'))).status).toBe(400);
    expect((await request(app).put(path).set(headers()).type('application/pdf').send(Buffer.alloc(3500001))).status).toBe(413);
    expect((await request(app).put(path).set(headers()).type('text/html').send('<script>')).status).toBe(400);
    expect(storageUpload).not.toHaveBeenCalled();
  });
  it('requires both documents to submit and denies changes after approval', async () => {
    application.credentials = []; expect((await request(app).post(`/doctors/applications/${id}/submit`).set(headers()).send({})).status).toBe(409);
    application.credentials = [credential('licence'), credential('registrationCertificate')]; expect((await request(app).post(`/doctors/applications/${id}/submit`).set(headers()).send({})).status).toBe(200);
    profile.verificationStatus = 'VERIFIED'; expect((await request(app).post(`/doctors/applications/${id}/submit`).set(headers()).send({})).status).toBe(409);
  });
  it('enforces platform access, fresh MFA and approval permission', async () => {
    expect((await request(app).get('/platform/doctors').set(headers())).status).toBe(403);
    expect((await request(app).get('/platform/doctors').set({ ...headers(reviewer), 'X-Test-Platform': 'true' })).status).toBe(403);
    expect((await request(app).get('/platform/doctors').set(staff())).status).toBe(200);
    expect((await request(app).post(`/platform/doctors/${professionalId}/approve`).set({ ...staff(), 'X-Test-Approve': 'false' }).send({})).status).toBe(403);
  });
  it('only previews latest released CLEAN documents for 60 seconds', async () => {
    const path = `/platform/doctors/${professionalId}/credentials/${credentialId}/preview`;
    expect((await request(app).get(path).set(staff())).status).toBe(200); expect(signed).toHaveBeenCalledWith('synthetic.pdf', 60);
    application.credentials[0].scanStatus = 'INFECTED'; expect((await request(app).get(path).set(staff())).status).toBe(409);
    application.credentials = []; expect((await request(app).get(path).set(staff())).status).toBe(404);
  });
  it('does not let reviewers verify their own files or unscreened files', async () => {
    const path = `/platform/doctors/${professionalId}/credentials/${credentialId}/review`;
    const decision = { reviewStatus: 'VERIFIED', sourceName: 'Synthetic authority', reference: 'TEST-REF', note: 'Synthetic test findings only.' };
    expect((await request(app).post(path).set(staff(owner)).send(decision)).status).toBe(403);
    application.credentials[0].scanStatus = 'PENDING'; expect((await request(app).post(path).set(staff()).send(decision)).status).toBe(409);
    application.credentials[0].scanStatus = 'CLEAN'; expect((await request(app).post(path).set(staff()).send(decision)).status).toBe(200);
    expect(db.doctorCredential.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reviewedBy: reviewer, sourceName: 'Synthetic authority' }) }));
  });
  it('checks current gates again on approval and sends no password in the approval email', async () => {
    const path = `/platform/doctors/${professionalId}/approve`;
    application.credentials[0].reviewStatus = 'PENDING'; expect((await request(app).post(path).set(staff()).send({})).status).toBe(409); expect(db.professionalProfile.update).not.toHaveBeenCalled();
    application.credentials[0].reviewStatus = 'VERIFIED'; expect((await request(app).post(path).set(staff(owner)).send({})).status).toBe(403);
    const response = await request(app).post(path).set(staff()).send({}); expect(response.status).toBe(200); expect(response.body.data.emailSent).toBe(true);
    expect(db.professionalProfile.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ verificationStatus: 'VERIFIED', decidedByUserId: reviewer }) }));
    const mail = JSON.parse(globalThis.fetch.mock.calls.at(-1)[1].body); expect(mail.text).toContain('/doctor-portal/login'); expect(mail.text).not.toContain(body.password);
  });
  it('never exposes private keys or raw DB errors', async () => {
    db.professionalProfile.findFirst.mockRejectedValue(new Error('database-password-secret'));
    const response = await request(app).get('/doctors/me').set(headers()); expect(response.status).toBe(503); expect(JSON.stringify(response.body)).not.toContain('database-password-secret');
  });
  it('accepts a profession-specific qualification upload, not doctor licence substitution', async()=>{
    profile.professionType='COUNSELLOR';application.details={professionType:'COUNSELLOR',discipline:'COUNSELLOR'};
    const ok=await request(app).put(`/doctors/applications/${id}/credentials/qualification`).set(headers()).type('application/pdf').send(bytes);
    expect(ok.status).toBe(201);
    expect((await request(app).put(`/doctors/applications/${id}/credentials/licence`).set(headers()).type('application/pdf').send(bytes)).status).toBe(400);
  });
  it('requests changes without granting access, then invalidates reviews on applicant corrections', async()=>{
    expect((await request(app).post(`/platform/doctors/${professionalId}/request-changes`).set(staff()).send({reason:'Please correct the qualification and institution details.'})).status).toBe(200);
    expect(db.doctorApplication.update).toHaveBeenCalledWith({where:{id},data:{stage:'CHANGES_REQUESTED',submittedAt:null}});
    const changed=await request(app).patch(`/doctors/applications/${id}/details`).set(headers()).send({qualification:'Corrected qualification'});
    expect(changed.status).toBe(200);expect(db.doctorCredential.updateMany).toHaveBeenCalledWith(expect.objectContaining({where:{applicationId:id},data:expect.objectContaining({reviewStatus:'PENDING'})}));
    expect((await request(app).patch(`/doctors/applications/${id}/details`).set(headers()).send({professionType:'DOCTOR'})).status).toBe(400);
  });
  it('denies another account correction and prevents approved application edits', async()=>{
    expect((await request(app).patch(`/doctors/applications/${id}/details`).set(headers(reviewer)).send({qualification:'Changed qualification'})).status).toBe(403);
    profile.verificationStatus='VERIFIED';expect((await request(app).patch(`/doctors/applications/${id}/details`).set(headers()).send({qualification:'Changed qualification'})).status).toBe(409);
    expect(db.doctorCredential.updateMany).not.toHaveBeenCalled();
  });
});
