// One device at a time, on a real database: signing in on a laptop ends the phone's session. The phone's
// next request, its background session check and its refresh are all refused with SIGNED_IN_ELSEWHERE so
// it can say why. Synthetic accounts only.
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { prisma } from './fixtures.js';

const PASSWORD = 'synthetic-passphrase-for-tests';
const PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const LAPTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

async function patient() {
  const tag = randomUUID().slice(0, 8);
  const user = await prisma.user.create({ data: { patientId: `SABI-SD-${tag}`, email: `one-device-${tag}@sessions.test`, password: await bcrypt.hash(PASSWORD, 4), full_name: `Patient ${tag}`, accountStatus: 'ACTIVE', emailVerifiedAt: new Date(), roles: { create: { role: 'PATIENT' } } } });
  return user;
}
const signIn = async (user, device) => {
  const response = await request(app).post('/api/v1/auth/login').set('User-Agent', device).send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return { access: `Bearer ${response.body.accessToken}`, refresh: response.body.refreshToken };
};
const me = (token) => request(app).get('/api/v1/auth/me').set('Authorization', token);
const check = (token) => request(app).get('/api/v1/auth/session').set('Authorization', token);

afterEach(() => { delete process.env.SINGLE_DEVICE_SESSIONS; });

describe('one device at a time', () => {
  it('signing in on the laptop signs the phone out, and the phone is told why', async () => {
    const user = await patient();
    const phone = await signIn(user, PHONE);
    expect((await check(phone.access)).status).toBe(200);
    const laptop = await signIn(user, LAPTOP);

    for (const response of [await me(phone.access), await check(phone.access)]) {
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: 'SIGNED_IN_ELSEWHERE', message: 'You were signed out because your account was signed in on another device.' });
    }
    const refresh = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: phone.refresh });
    expect(refresh.status).toBe(401);
    expect(refresh.body.code).toBe('SIGNED_IN_ELSEWHERE');

    expect((await me(laptop.access)).status).toBe(200);
    expect(await prisma.authSession.count({ where: { userId: user.id, revokedAt: null } })).toBe(1);
    const entries = (await request(app).get('/api/v1/audit/mine?category=SIGN_IN').set('Authorization', laptop.access)).body.data.items;
    expect(entries.map((e) => e.text)).toContain('Signing in here signed your account out on your other device');
  });

  it('the background session check does not keep an unattended session alive', async () => {
    const user = await patient();
    const phone = await signIn(user, PHONE);
    const before = await prisma.authSession.findFirst({ where: { userId: user.id, revokedAt: null } });
    await prisma.authSession.update({ where: { id: before.id }, data: { lastUsedAt: new Date(Date.now() - 60_000) } });
    expect((await check(phone.access)).status).toBe(200);
    const after = await prisma.authSession.findUnique({ where: { id: before.id } });
    expect(after.lastUsedAt.getTime()).toBeLessThan(Date.now() - 50_000);
  });

  it('a session signed out for another reason is not reported as "signed in elsewhere"', async () => {
    const user = await patient();
    const phone = await signIn(user, PHONE);
    expect((await request(app).post('/api/v1/auth/sessions/logout-all').set('Authorization', phone.access)).status).toBe(200);
    const response = await check(phone.access);
    expect(response.status).toBe(401);
    expect(response.body.code).toBeUndefined();
  });

  it('can be turned off with SINGLE_DEVICE_SESSIONS=false', async () => {
    process.env.SINGLE_DEVICE_SESSIONS = 'false';
    const user = await patient();
    const phone = await signIn(user, PHONE);
    await signIn(user, LAPTOP);
    expect((await me(phone.access)).status).toBe(200);
  });
});
