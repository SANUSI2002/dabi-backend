// Lists every route the Express app registers (method + path), for documentation coverage checks.
// Usage: node scripts/route-inventory.mjs [--json]
process.env.NODE_ENV ??= 'test';
process.env.SKIP_DB_CONNECT ??= 'true';
process.env.JWT_SECRET ??= 'route-inventory-only-not-a-real-secret';
process.env.DATABASE_URL ??= 'postgresql://inventory:inventory@localhost:5432/inventory';
process.env.EMR_API_ENABLED ??= 'true';

const { app } = await import('../src/app.js');

/** Turns an Express 4 mount regexp back into a path, naming its parameters from the layer keys. */
function mountPath(layer) {
  if (layer.regexp.fast_slash) return '';
  let index = 0;
  const name = () => layer.keys[index++]?.name ?? 'param';
  return layer.regexp.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/i, '')
    .replace(/\\\//g, '/')
    .replace(/\\\./g, '.')
    .replace(/\\-/g, '-')
    .replace(/\(\?:\/\(\[\^\/\]\+\?\)\)/g, () => `/:${name()}`)
    .replace(/\(\?:\(\[\^\/\]\+\?\)\)/g, () => `:${name()}`);
}

/**
 * Every route as { method, path, handlers }: `handlers` are the middleware the request passes —
 * those the enclosing routers apply with use() before the route, then the route's own.
 */
export function listRoutes(stack = app._router.stack, prefix = '', inherited = []) {
  const out = [];
  const before = [...inherited];
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        const full = `${prefix}${p}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
        // Router-level middleware applies to routes under the path it was mounted on.
        const applied = before.filter((m) => !m.base || full === m.base || full.startsWith(`${m.base}/`)).map((m) => m.handle);
        for (const method of Object.keys(layer.route.methods).filter((m) => layer.route.methods[m] && m !== '_all')) {
          out.push({ method, path: full, handlers: [...applied, ...layer.route.stack.map((s) => s.handle)] });
        }
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      out.push(...listRoutes(layer.handle.stack, `${prefix}${mountPath(layer)}`, before));
    } else if (layer.handle) {
      before.push({ handle: layer.handle, base: `${prefix}${mountPath(layer)}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1') });
    }
  }
  return out;
}

if (process.argv[1]?.endsWith('route-inventory.mjs')) {
  const routes = listRoutes().map(({ method, path }) => ({ method, path }));
  const unique = [...new Map(routes.map((r) => [`${r.method} ${r.path}`, r])).values()];
  if (process.argv.includes('--json')) console.log(JSON.stringify(unique));
  else for (const r of unique) console.log(r.method.toUpperCase().padEnd(7), r.path);
  process.exit(0);
}
