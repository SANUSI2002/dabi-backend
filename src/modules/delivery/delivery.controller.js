import * as s from './delivery.service.js';

const handle = (work) => async (req, res, next) => {
  try { res.json({ status: 'success', data: await work(req) }); }
  catch (error) { next(error); }
};
export const configure = handle((q) => s.configure(q.user.id, q.params.id, q.body));
export const partners = handle((q) => s.partners(q.user.id, q.query));
export const assign = handle((q) => s.assign(q.user.id, q.params.id, q.body));
export const queue = handle((q) => s.queue(q.user.id, q.query));
export const detail = handle((q) => s.detail(q.user.id, q.params.id));
export const accept = handle((q) => s.respond(q.user.id, q.params.id));
export const reject = handle((q) => s.respond(q.user.id, q.params.id, q.body.reason));
export const transition = handle((q) => s.transition(q.user.id, q.params.id, q.body));
export const location = handle((q) => s.location(q.user.id, q.params.id, q.body));
export const tracking = handle((q) => s.tracking(q.user.id, q.params.id));
export const errorHandler = (error, req, res, next) => {
  const status = { FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, P2002: 409, P2034: 409 }[error.code] ?? 500;
  const message = { 403: 'Access denied', 404: 'Delivery resource not found',
    409: 'Delivery state changed or action unavailable', 500: 'Delivery temporarily unavailable' }[status];
  res.status(status).json({ status: 'error', message });
};
