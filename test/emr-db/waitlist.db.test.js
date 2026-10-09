// The public Sabi AI waitlist on a real database. Synthetic addresses only.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { prisma } from './fixtures.js';

const join = (body) => request(app).post('/api/v1/waitlist').send(body);
const entry = (overrides = {}) => ({ product: 'sabi-ai', email: `Clinician.${randomUUID().slice(0, 8)}@waitlist.test`, name: 'Synthetic Clinician', role: 'PROFESSIONAL', organisation: 'Synthetic Clinic', consent: true, source: 'ai-hero', ...overrides });

describe('Sabi AI waitlist', () => {
  it('saves contact details without a sign-in, once per email, with the same answer either way', async () => {
    const body = entry();
    const first = await join(body);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ status: 'success', data: { joined: true } });
    const again = await join({ ...body, role: 'CAREGIVER', email: body.email.toUpperCase() });
    expect(again.body).toEqual(first.body);
    const rows = await prisma.waitlistSignup.findMany({ where: { email: body.email.toLowerCase() } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ product: 'SABI_AI', role: 'CAREGIVER', fullName: 'Synthetic Clinician', organisation: 'Synthetic Clinic', source: 'ai-hero' });
  });

  it('requires consent, a real email and a known role, and accepts nothing else', async () => {
    expect((await join(entry({ consent: false }))).status).toBe(400);
    expect((await join(entry({ email: 'not-an-email' }))).status).toBe(400);
    expect((await join(entry({ role: 'ADMIN' }))).status).toBe(400);
    expect((await join(entry({ product: 'other' }))).status).toBe(400);
    expect((await join({ ...entry(), symptoms: 'chest pain' })).status).toBe(400);
  });
});
