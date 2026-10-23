import express from 'express';

// Request-only host: deliberately does not import or start interval workers.
// Database queues must have a separately deployed, authenticated worker before
// promoting this host. Existing combined development entrypoint is unchanged.
export function createApiHost({ app, checkDatabase, checkStorage, now = Date.now }) {
  const host = express();
  host.disable('x-powered-by');
  let draining = false;
  let verifiedAt = null;
  let checking;
  const preflight = async () => {
    if (draining) throw new Error('RUNTIME_DRAINING');
    if (verifiedAt !== null && now() - verifiedAt < 30_000) return;
    checking ||= Promise.resolve().then(async () => {
      await checkDatabase();
      await checkStorage();
      verifiedAt = now();
    }).finally(() => { checking = undefined; });
    await checking;
    if (draining) throw new Error('RUNTIME_DRAINING');
  };
  host.get('/healthz/live', (_req, res) => {
    res.set('Cache-Control', 'no-store').status(draining ? 503 : 200).json({ status: draining ? 'draining' : 'alive' });
  });
  host.get('/healthz/ready', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await preflight(); res.json({ status: 'ready' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  host.use((_req, res, next) => {
    if (draining) return res.status(503).set('Retry-After', '5').json({ status: 'unavailable' });
    next();
  });
  host.use(app);
  return { host, preflight, drain: () => { draining = true; verifiedAt = null; } };
}
