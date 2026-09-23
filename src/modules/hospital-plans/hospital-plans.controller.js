import * as service from './hospital-plans.service.js';
const handle = (work, success = 200) => async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  try { return res.status(success).json({ status: 'success', data: await work(req) }); }
  catch (error) {
    if (error.code === 'NOT_FOUND') return res.status(404).json({ status: 'error', message: 'Hospital plan not found' });
    if (error.code === 'P2034') return res.status(409).json({ status: 'error', message: 'Hospital or plan changed. Reload and retry.' });
    return next(error);
  }
};
export const create = handle((req) => service.create(req.user.id, req.params.hospitalId, req.body), 201);
export const ownerList = handle((req) => service.list(req.params.hospitalId, req.query, req.user.id));
export const publicList = handle((req) => service.list(req.params.hospitalId, req.query));
export const detail = handle((req) => service.detail(req.params.hospitalId, req.params.planId));
export const update = handle((req) => service.update(req.user.id, req.params.hospitalId, req.params.planId, req.body));
export const archive = handle((req) => service.archive(req.user.id, req.params.hospitalId, req.params.planId));
export const errorHandler = (error, req, res, next) => res.status(500).json({ status: 'error', message: 'Hospital plan service temporarily unavailable' });
