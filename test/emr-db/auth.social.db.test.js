// Google and Apple sign-in against a real database. Google's and Apple's servers are replaced by a
// local stand-in that signs tokens with a throwaway key, so every check the server makes (signature,
// issuer, audience, expiry, nonce, verified email) runs exactly as in production. Synthetic accounts only.
import crypto, { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../../src/app.js';
import { resetSocialKeyCache } from '../../src/modules/auth/auth.social.js';
import { rateLimitKey, socialLimiter } from '../../src/middleware/rateLimitMiddleware.js';
import { prisma } from './fixtures.js';

const GOOGLE_ID = 'synthetic-google-client.apps.googleusercontent.com';
const APPLE_ID = 'health.sabi.synthetic.web';
const signer = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...signer.publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
const codes = new Map();
const tokenRequests = [];
const realFetch = globalThis.fetch;
const { Response, URLSearchParams } = globalThis;

const idToken = (claims, { key = signer.privateKey, kid = 'synthetic-key' } = {}) => jwt.sign(claims, key, { algorithm: 'RS256', keyid: kid, expiresIn: '5m' });
const googleCode = (claims, opts) => {
  const code = `code-${randomUUID()}`;
  codes.set(code, idToken({ iss: 'https://accounts.google.com', aud: GOOGLE_ID, email_verified: true, ...claims }, opts));
  return code;
};
const tag = () => randomUUID().slice(0, 8);
const google = (body, origin = 'http://localhost:5173') => request(app).post('/api/v1/auth/social/google').set('Origin', origin).send(body);

beforeAll(() => {
  Object.assign(process.env, { CLIENT_URLS: 'http://localhost:5173,https://doctor.sabihealth.org', GOOGLE_OAUTH_CLIENT_ID: GOOGLE_ID, GOOGLE_OAUTH_CLIENT_SECRET: 'synthetic-secret-never-sent-to-browsers', APPLE_SERVICES_ID: APPLE_ID, APPLE_REDIRECT_URI: 'https://patients.sabi.test/login' });
  vi.stubGlobal('fetch', async (url, init) => {
    const target = String(url);
    if (target.includes('googleapis.com/oauth2/v3/certs') || target.includes('appleid.apple.com/auth/keys')) return Response.json({ keys: [jwk] }, { headers: { 'cache-control': 'max-age=3600' } });
    if (target === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(init.body);
      expect(form.get('client_secret')).toBe('synthetic-secret-never-sent-to-browsers');
      expect(['http://localhost:5173', 'https://doctor.sabihealth.org']).toContain(form.get('redirect_uri'));
      tokenRequests.push(form.get('redirect_uri'));
      const token = codes.get(form.get('code'));
      return token ? Response.json({ id_token: token }) : Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    return realFetch(url, init);
  });
});
beforeEach(() => {
  resetSocialKeyCache();
  // Independent scenarios must not consume one shared synthetic client's login budget.
  for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) socialLimiter.resetKey(rateLimitKey('social')({ ip }));
});
afterAll(() => {
  vi.unstubAllGlobals();
  for (const key of ['CLIENT_URLS', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'APPLE_SERVICES_ID', 'APPLE_REDIRECT_URI']) delete process.env[key];
});

describe('social sign-in', () => {
  it('binds popup code exchange to the approved calling origin, not a browser-supplied redirect URL', async () => {
    const injected = await google({ code: 'unused-code', redirectUri: 'https://attacker.invalid' }, 'https://doctor.sabihealth.org');
    expect(injected.status).toBe(400);
    const res = await google({ code: googleCode({ sub: `origin-${tag()}`, email: `origin-${tag()}@social.test` }) }, 'https://doctor.sabihealth.org');
    expect(res.status).toBe(200);
    expect(tokenRequests.at(-1)).toBe('https://doctor.sabihealth.org');
  });
  it('rejects missing and untrusted origins before contacting Google', async () => {
    const before = tokenRequests.length;
    const missing = await request(app).post('/api/v1/auth/social/google').send({ code: 'unused-code' });
    const foreign = await google({ code: 'unused-code' }, 'https://attacker.invalid');
    expect(missing.status).toBe(403);
    expect(foreign.status).toBe(403);
    expect(tokenRequests.length).toBe(before);
  });
  it('tells the sign-in page which providers are on, without any secret', async () => {
    const res = await request(app).get('/api/v1/auth/social/providers');
    expect(res.body.data).toEqual({ google: { clientId: GOOGLE_ID }, apple: { clientId: APPLE_ID, redirectUri: 'https://patients.sabi.test/login' } });
    expect(JSON.stringify(res.body)).not.toContain('synthetic-secret');
  });

  it('creates a patient only after the terms are accepted, then signs the same Google account back in', async () => {
    const email = `new-${tag()}@social.test`;
    const sub = `google-${tag()}`;
    const first = await google({ code: googleCode({ sub, email, given_name: 'Ada', family_name: 'Synthetic' }) });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'signup_required', profile: { provider: 'GOOGLE', email, firstName: 'Ada' } });
    expect(await prisma.user.count({ where: { email } })).toBe(0);

    const done = await request(app).post('/api/v1/auth/social/complete').send({ signupToken: first.body.signupToken, consentGiven: true });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ accountCreated: true, provider: 'GOOGLE', user: { email, fullName: 'Ada Synthetic', accountStatus: 'ACTIVE', roles: ['PATIENT'] } });
    const user = await prisma.user.findUnique({ where: { email }, include: { identityProviders: true, profile: true } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.profile.consentGiven).toBe(true);
    expect(user.identityProviders).toMatchObject([{ provider: 'GOOGLE', subject: sub }]);

    // Later sign-ins find the account by Google's id, even if the Google email changed.
    const again = await google({ code: googleCode({ sub, email: `renamed-${tag()}@social.test` }) });
    expect(again.status).toBe(200);
    expect(again.body.user.id).toBe(user.id);
    const log = (await request(app).get('/api/v1/audit/mine?category=SIGN_IN').set('Authorization', `Bearer ${again.body.accessToken}`)).body.data.items.map((e) => e.text);
    expect(log).toContain('You signed in with Google');
  });

  it('signs up in one step when the terms were already accepted on the sign-up page', async () => {
    const email = `direct-${tag()}@social.test`;
    const res = await google({ code: googleCode({ sub: `google-${tag()}`, email }), consentGiven: true });
    expect(res.body).toMatchObject({ accountCreated: true, user: { email } });
  });

  it('connects an existing account by verified email, and keeps its password working', async () => {
    const email = `existing-${tag()}@social.test`;
    const password = 'Synthetic-password-1!';
    const existing = await prisma.user.create({ data: { patientId: `SABI-SO-${tag()}`, email, password: await bcrypt.hash(password, 4), full_name: 'Existing Person', accountStatus: 'ACTIVE', emailVerifiedAt: new Date(), roles: { create: { role: 'PATIENT' } } } });
    const res = await google({ code: googleCode({ sub: `google-${tag()}`, email }) });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(existing.id);
    expect(res.body.accountCreated).toBe(false);
    expect(await prisma.auditEvent.findFirst({ where: { actorUserId: existing.id, action: 'GOOGLE_CONNECTED' } })).not.toBeNull();
    expect((await request(app).post('/api/v1/auth/login').send({ email, password })).status).toBe(200);

    // A second, different Google account cannot take over the same Sabi account.
    const other = await google({ code: googleCode({ sub: `google-${tag()}`, email }) });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('SOCIAL_ACCOUNT_CONFLICT');
  });

  it('activates an unverified sign-up for the real email owner and stops the typed password', async () => {
    const email = `pending-${tag()}@social.test`;
    const password = 'Typed-by-someone-else-1!';
    const pending = await prisma.user.create({ data: { patientId: `SABI-SO-${tag()}`, email, password: await bcrypt.hash(password, 4), full_name: 'Pending Person', accountStatus: 'PENDING', roles: { create: { role: 'PATIENT' } } } });
    const res = await google({ code: googleCode({ sub: `google-${tag()}`, email }) });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: pending.id, accountStatus: 'ACTIVE' });
    expect((await request(app).post('/api/v1/auth/login').send({ email, password })).status).toBe(401);
  });

  it('refuses unverified emails, forged or misdirected tokens, and accounts that are switched off', async () => {
    const email = `unverified-${tag()}@social.test`;
    const unverified = await google({ code: googleCode({ sub: `google-${tag()}`, email, email_verified: false }), consentGiven: true });
    expect(unverified.status).toBe(400);
    expect(unverified.body.error.code).toBe('SOCIAL_EMAIL_UNVERIFIED');
    expect(await prisma.user.count({ where: { email } })).toBe(0);

    const forged = await google({ code: googleCode({ sub: `google-${tag()}`, email: `forged-${tag()}@social.test` }, { key: stranger.privateKey }), consentGiven: true });
    expect(forged.status).toBe(401);
    const otherApp = await google({ code: googleCode({ sub: `google-${tag()}`, email: `aud-${tag()}@social.test`, aud: 'someone-elses-app' }), consentGiven: true });
    expect(otherApp.status).toBe(401);
    expect((await google({ code: 'code-that-google-never-issued' })).status).toBe(401);

    const suspendedEmail = `suspended-${tag()}@social.test`;
    await prisma.user.create({ data: { patientId: `SABI-SO-${tag()}`, email: suspendedEmail, password: 'x', accountStatus: 'SUSPENDED', emailVerifiedAt: new Date(), roles: { create: { role: 'PATIENT' } } } });
    const suspended = await google({ code: googleCode({ sub: `google-${tag()}`, email: suspendedEmail }) });
    expect(suspended.status).toBe(403);
    expect(suspended.body.error.code).toBe('ACCOUNT_UNAVAILABLE');
  });

  it('still asks for two-step verification', async () => {
    const email = `mfa-${tag()}@social.test`;
    const user = await prisma.user.create({ data: { patientId: `SABI-SO-${tag()}`, email, password: 'x', accountStatus: 'ACTIVE', emailVerifiedAt: new Date(), roles: { create: { role: 'PATIENT' } } } });
    await prisma.mfaTotp.create({ data: { userId: user.id, encryptedSecret: 'synthetic', enabledAt: new Date() } });
    const res = await google({ code: googleCode({ sub: `google-${tag()}`, email }) });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'mfa_required' });
    expect(res.body.accessToken).toBeUndefined();
  });

  it('accepts an Apple token only with the nonce this server issued', async () => {
    const { nonce } = (await request(app).post('/api/v1/auth/social/nonce')).body.data;
    const sub = `apple-${tag()}.0001`;
    const email = `relay-${tag()}@privaterelay.appleid.com`;
    const token = (claims) => idToken({ iss: 'https://appleid.apple.com', aud: APPLE_ID, sub, email, email_verified: 'true', ...claims });

    const res = await request(app).post('/api/v1/auth/social/apple').send({ idToken: token({ nonce }), nonce, firstName: 'Bola', lastName: 'Synthetic', consentGiven: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ accountCreated: true, provider: 'APPLE', user: { email, fullName: 'Bola Synthetic' } });

    const madeUp = 'aaaaaaaaaaaaaaaaaaaaaaaa.9999999999999.forged';
    expect((await request(app).post('/api/v1/auth/social/apple').send({ idToken: token({ nonce: madeUp }), nonce: madeUp })).status).toBe(401);
    const { nonce: second } = (await request(app).post('/api/v1/auth/social/nonce')).body.data;
    expect((await request(app).post('/api/v1/auth/social/apple').send({ idToken: token({ nonce }), nonce: second })).status).toBe(401);
  });
});
