// Structured JSON logging + per-tenant request metrics for the EMR. Logs carry identifiers and
// codes only — never names, dates of birth or clinical text.
import { randomUUID } from 'node:crypto';

const write = (level, event, fields) => {
  if (process.env.NODE_ENV === 'test' && process.env.EMR_LOG_IN_TESTS !== 'true') return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service: 'emr', event, ...fields });
  (level === 'error' ? console.error : console.log)(line);
};

export const logger = {
  info: (event, fields = {}) => write('info', event, fields),
  warn: (event, fields = {}) => write('warn', event, fields),
  error: (event, fields = {}) => write('error', event, fields),
};

// ---- per-tenant metrics (in-process; scraped via GET /api/v1/emr/internal/metrics) ----
const tenants = new Map();
const bucket = (organizationId) => {
  const key = organizationId || 'unresolved';
  if (!tenants.has(key)) tenants.set(key, { requests: 0, errors: 0, rateLimited: 0, totalMs: 0, maxMs: 0 });
  return tenants.get(key);
};

export const recordRequest = (organizationId, status, ms) => {
  const metric = bucket(organizationId);
  metric.requests += 1;
  metric.totalMs += ms;
  metric.maxMs = Math.max(metric.maxMs, ms);
  if (status >= 500) metric.errors += 1;
  if (status === 429) metric.rateLimited += 1;
};

export const metricsSnapshot = () => [...tenants.entries()].map(([organizationId, metric]) => ({
  organizationId,
  requests: metric.requests,
  errors: metric.errors,
  rateLimited: metric.rateLimited,
  avgMs: metric.requests ? Math.round(metric.totalMs / metric.requests) : 0,
  maxMs: Math.round(metric.maxMs),
}));

export const resetMetrics = () => tenants.clear();

// Assigns (or accepts a well-formed) request id, echoes it, and logs one line per request.
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
export const requestContext = (req, res, next) => {
  const incoming = req.get('x-request-id');
  req.requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.set('X-Request-Id', req.requestId);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const organizationId = req.emr?.organizationId;
    recordRequest(organizationId, res.statusCode, ms);
    logger.info('emr.request', {
      requestId: req.requestId,
      organizationId,
      userId: req.user?.id,
      method: req.method,
      route: `${req.baseUrl}${req.route?.path ?? ''}`,
      status: res.statusCode,
      ms: Math.round(ms * 10) / 10,
    });
  });
  next();
};
