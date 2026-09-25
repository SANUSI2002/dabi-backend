import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

// A database stand-in for the whole app: lists are empty, counts are zero, lookups miss.
const model = new Proxy({}, { get: (_, method) => vi.fn(async () => (method === 'count' ? 0 : method === 'findMany' ? [] : null)) });
const prisma = new Proxy({}, {
  get: (_, key) => {
    if (key === '$transaction') return async (work) => (typeof work === 'function' ? work(prisma) : Promise.all(work));
    if (key === 'then') return undefined;
    return model;
  },
});
vi.mock('../src/config/db.js', () => ({ default: prisma }));

process.env.JWT_SECRET = 'app-routing-test';
const { app } = await import('../src/app.js');
const id = '11111111-1111-4111-8111-111111111111';

// These exercise the real mount order in src/app.js, which per-module tests can't see:
// the '/api/v1' payment router requires sign-in for every path that reaches it.
describe('application route order', () => {
  it('serves the public wellness catalogue without sign-in', async () => {
    const list = await request(app).get('/api/v1/wellness');
    expect(list.status).toBe(200);
    expect(list.body.data).toMatchObject({ items: [], total: 0 });
    expect((await request(app).get(`/api/v1/wellness/${id}`)).status).toBe(404);
  });

  it.each([
    ['get', '/api/v1/wellness/bookings/mine'],
    ['post', '/api/v1/wellness/bookings'],
    ['get', '/api/v1/hospital-enrollments/mine'],
    ['post', '/api/v1/hospital-enrollments'],
    ['get', '/api/v1/hospital-appointments/mine'],
    ['post', `/api/v1/hospital-appointments/${id}/check-in`],
    ['get', '/api/v1/medical-documents'],
    ['post', '/api/v1/medical-documents/uploads'],
  ])('requires sign-in for %s %s', async (method, path) => {
    expect((await request(app)[method](path).send({})).status).toBe(401);
  });

  it('rejects an unsigned document-scan callback before parsing it', async () => {
    const response = await request(app)
      .post(`/api/v1/internal/document-scans/${id}/result`)
      .set('content-type', 'application/json')
      .send(JSON.stringify({ verdict: 'CLEAN' }));
    expect([401, 403]).toContain(response.status);
  });

  it('serves the API reference and health check', async () => {
    expect((await request(app).get('/api/openapi.json')).status).toBe(200);
    expect((await request(app).get('/api/docs/')).status).toBe(200);
    expect((await request(app).get('/api/health')).status).toBe(200);
  });
});
