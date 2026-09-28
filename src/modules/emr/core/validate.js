// Zod validation for EMR routes, reported in the EMR error envelope (VALIDATION_FAILED with
// field paths). Unknown fields are rejected by the schemas (.strict()), so a client can never
// smuggle organizationId, version, createdBy… into a write.
import { EmrError } from './errors.js';

export const validateEmr = (schema) => (req, res, next) => {
  const result = schema.safeParse({ body: req.body ?? {}, query: req.query, params: req.params });
  if (!result.success) {
    return next(new EmrError('VALIDATION_FAILED', {
      details: result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    }));
  }
  if (result.data.body !== undefined) req.body = result.data.body;
  // Express 4 exposes req.query through a getter on some setups; define it explicitly.
  if (result.data.query !== undefined) Object.defineProperty(req, 'query', { value: result.data.query, writable: true, configurable: true });
  if (result.data.params !== undefined) req.params = { ...req.params, ...result.data.params };
  return next();
};

// Wraps an async handler so rejections reach emrErrorHandler.
export const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
