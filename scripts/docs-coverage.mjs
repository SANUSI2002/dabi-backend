// Documentation coverage: which registered routes have no operation in docs/openapi.yaml, and
// which documented operations no longer exist. Exits non-zero when anything is out of step.
// Usage: node scripts/docs-coverage.mjs [--verbose]
import fs from 'node:fs';
import YAML from 'yaml';
import { listRoutes } from './route-inventory.mjs';

// Not part of the public contract: the docs UI itself.
const IGNORED = new Set(['get /api/openapi.json', 'get /api/docs', 'get /api/docs/']);
const norm = (path) => path.replace(/\{[^}]+\}/g, '{}').replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '{}');

const routes = [...new Map(listRoutes().map((r) => [`${r.method} ${r.path}`, r])).values()]
  .filter((r) => !IGNORED.has(`${r.method} ${r.path}`));
const spec = YAML.parse(fs.readFileSync('docs/openapi.yaml', 'utf8'));
const documented = new Set(Object.entries(spec.paths ?? {}).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m} ${norm(path)}`)));
const registered = new Set(routes.map((r) => `${r.method} ${norm(r.path)}`));

const missing = routes.filter((r) => !documented.has(`${r.method} ${norm(r.path)}`));
const stale = [...documented].filter((key) => !registered.has(key));
console.log(`${routes.length} registered operations, ${documented.size} documented; ${missing.length} undocumented, ${stale.length} documented but not registered.`);
if (process.argv.includes('--verbose')) {
  for (const r of missing) console.log('  undocumented', r.method.toUpperCase(), r.path);
  for (const key of stale) console.log('  stale       ', key);
}
process.exit(missing.length || stale.length ? 1 : 0);
