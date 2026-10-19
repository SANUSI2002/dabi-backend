// Registering as a professional with Google / Apple, against a real database. Google is replaced by a
// local stand-in that signs tokens with a throwaway key; private storage is an in-memory double. The
// point: only the account step changes — the application, credential upload, screening and staff review
// are the same records and rules as an email-and-password registration. Synthetic data only.
import crypto, { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from './fixtures.js';
const { Response, URLSearchParams } = globalThis;

// No verification email may be needed (or sent) for a Google-proven address.
const email = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../src/modules/auth/auth.email.js', () => ({
  verificationEmailConfigured: () => false, verificationEmailAllowedFor: () => false, sendEmailVerificationEmail: email.send,
  passwordResetEmailConfigured: () => false, passwordResetEmailAllowedFor: () => false, sendPasswordResetEmail: vi.fn(),
}));
const objects = new Map();
const storage = { storage: {
  getBucket: async () => ({ data: { public: false } }),
  from: (bucket) => ({ upload: async (path, bytes) => { objects.set(`${bucket}/${path}`, bytes); return { data: { path } }; }, remove: async () => ({}) }),
} };
vi.mock('../../src/config/privateStorage.js', async (original) => ({ ...await original(), privateStorageClient: () => storage }));
const { app } = await import('../../src/app.js');
const { resetSocialKeyCache } = await import('../../src/modules/auth/auth.social.js');

const GOOGLE_ID = 'synthetic-pro.apps.googleusercontent.com';
const signer = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...signer.publicKey.export({ format: 'jwk' }), kid: 'pro-key', alg: 'RS256' };
const codes = new Map();
const realFetch = globalThis.fetch;
const tag = () => randomUUID().slice(0, 8);
const googleCode = (claims) => {
  const code = `code-${randomUUID()}`;
  codes.set(code, jwt.sign({ iss: 'https://accounts.google.com', aud: GOOGLE_ID, email_verified: true, ...claims }, signer.privateKey, { algorithm: 'RS256', keyid: 'pro-key', expiresIn: '5m' }));
  return code;
};
const doctor = (extra) => ({
  firstName: 'Ifeoma', lastName: 'Synthetic', phone: '+2348030000000', specialty: 'General Practice', qualification: 'MBBS', university: 'University of Lagos',
  graduationYear: 2014, registrationNumber: `MDCN-${tag()}`, practiceState: 'Lagos', city: 'Ikeja', licenceType: 'life',
  declaration: true, termsAccepted: true, country: 'NG', regulator: 'MDCN', consentVersion: 'doctor-registration-v1', ...extra,
});
const ENV = { GOOGLE_OAUTH_CLIENT_ID: GOOGLE_ID, GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-secret', DOCTOR_REGISTRATION_ENABLED: 'true', EVIDENCE_SCANNER_ENABLED: 'true', EVIDENCE_SCANNER_PROVIDER: 'clamav' };

beforeAll(() => {
  Object.assign(process.env, ENV);
  resetSocialKeyCache();
  vi.stubGlobal('fetch', async (url, init) => {
    const target = String(url);
    if (target.includes('googleapis.com/oauth2/v3/certs')) return Response.json({ keys: [jwk] });
    if (target === 'https://oauth2.googleapis.com/token') {
      const token = codes.get(new URLSearchParams(init.body).get('code'));
      return token ? Response.json({ id_token: token }) : Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    return realFetch(url, init);
  });
});
afterAll(() => { vi.unstubAllGlobals(); for (const key of Object.keys(ENV)) delete process.env[key]; });

describe('professional registration with Google', () => {
  it('never makes a patient from the professional portal; registers, signs in and allows uploads at once; review still required', async () => {
    const address = `dr-${tag()}@social.test`;
    const sub = `google-${tag()}`;
    const first = await request(app).post('/api/v1/auth/social/google').send({ code: googleCode({ sub, email: address, given_name: 'Ifeoma' }), intent: 'professional', consentGiven: true });
    expect(first.body).toMatchObject({ status: 'signup_required', profile: { email: address, firstName: 'Ifeoma' } });
    expect(await prisma.user.count({ where: { email: address } })).toBe(0);

    const registered = await request(app).post('/api/v1/doctors/register').send(doctor({ socialSignupToken: first.body.signupToken }));
    expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    expect(registered.body).toMatchObject({ accessToken: expect.any(String), user: { email: address, accountStatus: 'ACTIVE', roles: ['PROFESSIONAL'] }, data: { status: 'documents_pending', email: address } });
    expect(email.send).not.toHaveBeenCalled();
    const user = await prisma.user.findUnique({ where: { email: address }, include: { identityProviders: true, professionalProfile: { include: { doctorApplication: true } } } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.identityProviders).toMatchObject([{ provider: 'GOOGLE', subject: sub }]);
    expect(user.professionalProfile.verificationStatus).toBe('PENDING');
    expect(user.professionalProfile.doctorApplication.details).not.toHaveProperty('socialSignupToken');
    expect(user.professionalProfile.doctorApplication.details.email).toBe(address);

    // Credential upload works straight away, with the same screening queue as everyone else.
    const auth = `Bearer ${registered.body.accessToken}`;
    const upload = await request(app).put(`/api/v1/doctors/applications/${registered.body.data.applicationId}/credentials/licence`)
      .set('Authorization', auth).set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.4 synthetic licence'));
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    expect(upload.body.data).toMatchObject({ kind: 'licence', scanStatus: 'PENDING', reviewStatus: 'PENDING' });
    expect((await request(app).get('/api/v1/doctors/me').set('Authorization', auth)).body.data).toMatchObject({ status: 'PENDING' });

    // Later, Google signs the same professional back in (approval is still up to staff).
    const again = await request(app).post('/api/v1/auth/social/google').send({ code: googleCode({ sub, email: address }), intent: 'professional' });
    expect(again.status).toBe(200);
    expect(again.body.user).toMatchObject({ id: user.id, roles: ['PROFESSIONAL'] });
  });

  it('takes the email from Google only, and refuses mixed or tampered requests', async () => {
    const address = `dr-${tag()}@social.test`;
    const { signupToken } = (await request(app).post('/api/v1/auth/social/google').send({ code: googleCode({ sub: `google-${tag()}`, email: address }), intent: 'professional' })).body;
    expect((await request(app).post('/api/v1/doctors/register').send(doctor({ socialSignupToken: signupToken, email: 'someone-else@social.test' }))).status).toBe(400);
    expect((await request(app).post('/api/v1/doctors/register').send(doctor({ socialSignupToken: signupToken, password: 'a-long-synthetic-passphrase' }))).status).toBe(400);
    expect((await request(app).post('/api/v1/doctors/register').send(doctor({}))).status).toBe(400);
    const forged = jwt.sign({ provider: 'GOOGLE', sub: 'x', email: 'forged@social.test', emailVerified: true }, 'not-the-server-key', { audience: 'sabi-social-signup', expiresIn: '10m' });
    const tampered = await request(app).post('/api/v1/doctors/register').send(doctor({ socialSignupToken: forged }));
    expect(tampered.status).toBe(401);
    expect(await prisma.user.count({ where: { email: 'forged@social.test' } })).toBe(0);
  });
});
