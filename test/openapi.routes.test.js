import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import routes, { specification } from '../src/docs/openapi.routes.js';

const app = express(); app.use('/api', routes);
const operations = () => Object.entries(specification.paths).flatMap(([path, item]) => Object.entries(item).map(([method, operation]) => ({ path, method, operation })));

describe('public OpenAPI reference', () => {
  it('serves canonical OpenAPI 3.1 JSON without a database', async () => {
    const response = await request(app).get('/api/openapi.json');
    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe('3.1.0');
    expect(response.body.info.title).toBe('Sabi Health Backend API');
    expect(Object.keys(response.body.paths).length).toBeGreaterThan(140);
  });

  it('serves Swagger UI at /api/docs/ (redirecting the bare path so its relative assets resolve)', async () => {
    const bare = await request(app).get('/api/docs');
    expect(bare.status).toBe(301);
    expect(bare.headers.location).toBe('/api/docs/');
    const response = await request(app).get('/api/docs/');
    expect(response.status).toBe(200);
    expect(response.type).toBe('text/html');
    expect(response.text).toContain('id="swagger-ui"');
  });

  it('excludes the private scanner callback and secrets', () => {
    const serialized = JSON.stringify(specification);
    expect(serialized).not.toContain('/api/v1/internal/document-scans');
    for (const secret of ['DOCUMENT_SCAN_CALLBACK_SECRET','R2_SECRET_ACCESS_KEY','DATABASE_URL','X-Document-Scan-Signature']) expect(serialized).not.toContain(secret);
  });

  it('covers every core feature bucket and route inventory', () => {
    const expected = [
      'post /api/v1/auth/login','get /api/v1/profile','get /api/v1/dashboard','get /api/v1/notifications','post /api/v1/appointments','post /api/v1/medications','post /api/v1/vitals','get /api/v1/health-metrics','post /api/v1/medical-records','post /api/v1/medical-documents/uploads','get /api/v1/family-care/circle','get /api/v1/caregivers/me','post /api/v1/professionals/register','post /api/v1/organisations/register','get /api/v1/hospitals/{hospitalId}/plans','post /api/v1/hospital-enrollments','post /api/v1/hospital-appointments','get /api/v1/doctor-care/doctors','post /api/v1/prescriptions','get /api/v1/pharmacies','post /api/v1/inventory','post /api/v1/pharmacy-requests','post /api/v1/reservations','post /api/v1/checkout-pricing/preview/reservations/{id}','post /api/v1/orders','post /api/v1/orders/{id}/payment/initialize','post /api/v1/payments/paystack/webhook','get /api/v1/fulfilments','get /api/v1/delivery/assignments','post /api/v1/wellness/bookings',
    ];
    const actual = new Set(operations().map(({ method, path }) => `${method} ${path}`));
    expected.forEach((route) => expect(actual.has(route), route).toBe(true));
    expect(new Set(operations().flatMap(({ operation }) => operation.tags))).toEqual(new Set(specification.tags.map(({ name }) => name)));
  });

  it('marks protected operations with bearer auth and public operations explicitly', () => {
    const login = specification.paths['/api/v1/auth/login'].post;
    const profile = specification.paths['/api/v1/profile'].get;
    expect(login.security).toEqual([]);
    expect(profile.security).toEqual([{ bearerAuth: [] }]);
    expect(specification.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    for (const { operation } of operations()) expect(operation).toHaveProperty('security');
  });

  it('documents private document state, ephemeral URLs and review boundary', () => {
    const upload = specification.paths['/api/v1/medical-documents/uploads'].post;
    const ownerDownload = specification.paths['/api/v1/medical-documents/{id}/download'].post;
    const recipientDownload = specification.paths['/api/v1/medical-documents/shared-with-me/{shareId}/download'].post;
    expect(upload.description).toContain('short-lived signed PUT URL');
    expect(upload.responses['503']).toBeDefined();
    expect(ownerDownload.description).toContain('CLEAN');
    expect(recipientDownload.description).toContain('Authenticated named recipient');
    expect(specification.components.schemas.DocumentStatus.enum).toContain('PENDING_CLINICAL_REVIEW');
    expect(JSON.stringify(specification.components.schemas.SignedDownloadResponse)).toContain('never persist');
  });

  it('documents state machines and provider-facing Paystack behavior accurately', () => {
    expect(specification.paths['/api/v1/hospital-enrollments/{id}/approve'].post.description).toContain('PENDING to ACTIVE');
    expect(specification.paths['/api/v1/hospital-appointments/{id}/check-in'].post.description).toContain('SCHEDULED to CHECKED_IN');
    expect(specification.paths['/api/v1/wellness/bookings/{id}/confirm'].post.description).toContain('PENDING to CONFIRMED');
    expect(specification.paths['/api/v1/payments/paystack/webhook'].post.description).toContain('not a frontend action');
  });
});
