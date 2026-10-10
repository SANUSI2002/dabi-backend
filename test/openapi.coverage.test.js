import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

// No database is touched: the app is only loaded to read its route table.
vi.mock('../src/config/db.js', () => ({ default: new Proxy({}, { get: () => undefined }) }));
process.env.JWT_SECRET ??= 'openapi-coverage-test';
const { listRoutes } = await import('../scripts/route-inventory.mjs');

const IGNORED = new Set(['get /api/openapi.json', 'get /api/docs', 'get /api/docs/']);
const norm = (path) => path.replace(/\{[^}]+\}/g, '{}').replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '{}');

describe('API documentation (docs/openapi.yaml, served at /api/docs)', () => {
  const spec = YAML.parse(fs.readFileSync('docs/openapi.yaml', 'utf8'));
  const documented = new Set(Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m} ${norm(path)}`)));
  const routes = listRoutes().filter((r) => !IGNORED.has(`${r.method} ${r.path}`));
  const registered = new Set(routes.map((r) => `${r.method} ${norm(r.path)}`));

  it('documents every registered endpoint (run `npm run docs:routes` after adding one)', () => {
    const missing = routes.filter((r) => !documented.has(`${r.method} ${norm(r.path)}`)).map((r) => `${r.method.toUpperCase()} ${r.path}`);
    expect(missing).toEqual([]);
  });

  it('documents nothing the server no longer serves', () => {
    expect([...documented].filter((key) => !registered.has(key))).toEqual([]);
  });

  it('describes hospital endpoints with their permissions, headers and request bodies', () => {
    const perform = spec.paths['/api/v1/emr/organizations/{organizationId}/procedures/{procedureId}/perform'].post;
    expect(perform.description).toContain('`procedure.perform`');
    expect(perform.parameters.map((p) => p.name)).toEqual(expect.arrayContaining(['organizationId', 'procedureId', 'If-Match']));
    expect(perform.requestBody.content['application/json'].schema.required).toContain('outcome');
    expect(perform.responses).toHaveProperty('412');
    const book = spec.paths['/api/v1/emr/organizations/{organizationId}/appointments'].post;
    expect(book.parameters.map((p) => p.name)).toContain('Idempotency-Key');
    expect(book.responses).toHaveProperty('201');
  });
});
