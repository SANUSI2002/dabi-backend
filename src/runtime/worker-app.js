import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import { JOB_KINDS, validJobKind } from './job-kinds.js';

const verifier = new OAuth2Client();
export function createWorkerApp({ config, runJob, enqueue,
  verify = options => verifier.verifyIdToken(options), now = Date.now }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  // Cloud Run startup probe is internal to the platform. All business routes are
  // additionally protected by service-level IAM and verified Google OIDC here.
  app.get('/healthz/live', (_req, res) => res.json({ status: 'alive' }));
  app.use(async (req, res, next) => {
    const match = /^Bearer ([^\s]+)$/.exec(req.get('Authorization') || '');
    if (!match) return res.status(401).json({ status: 'unauthorised' });
    try {
      const ticket = await verify({ idToken: match[1], audience: config.workerUrl });
      const identity = ticket.getPayload();
      if (!identity || !['https://accounts.google.com', 'accounts.google.com'].includes(identity.iss)
        || identity.aud !== config.workerUrl || identity.email_verified !== true
        || ![config.invoker, config.scheduler].includes(identity.email)) throw new Error('INVALID_JOB_IDENTITY');
      req.jobIdentity = identity.email;
      next();
    } catch { res.status(401).json({ status: 'unauthorised' }); }
  });
  app.use(express.json({ limit: '1kb', strict: true }));
  const emptyBody = (req, res, next) => {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length) return res.status(400).json({ status: 'invalid_request' });
    next();
  };
  app.post('/internal/dispatch', emptyBody, async (req, res) => {
    if (req.jobIdentity !== config.scheduler) return res.status(403).json({ status: 'forbidden' });
    const slot = Math.floor(now() / 60_000);
    const results = await Promise.allSettled(JOB_KINDS.map(kind => enqueue(kind, { id: `scheduled-${slot}` })));
    if (results.some(result => result.status === 'rejected')) return res.status(503).json({ status: 'retry' });
    res.json({ status: 'dispatched', categories: JOB_KINDS.length });
  });
  app.post('/internal/jobs/:kind', emptyBody, async (req, res) => {
    if (req.jobIdentity !== config.invoker) return res.status(403).json({ status: 'forbidden' });
    if (!validJobKind(req.params.kind)) return res.status(404).json({ status: 'not_found' });
    try {
      const result = await runJob(req.params.kind);
      if (result.state === 'busy') return res.status(409).json({ status: 'busy' });
      if (result.continue) await enqueue(req.params.kind);
      res.json({ status: result.state });
    } catch { res.status(503).json({ status: 'retry' }); }
  });
  app.use((_req, res) => res.status(404).json({ status: 'not_found' }));
  app.use((_error, _req, res, next) => { res.status(400).json({ status: 'invalid_request' }); });
  return app;
}
