import * as service from './caregivers.service.js';

export const register = async (req, res, next) => {
  try { res.status(201).json({ status: 'success', ...await service.register(req.body) }); }
  catch (error) { next(error); }
};
export const me = async (req, res, next) => {
  try { res.json({ status: 'success', data: await service.me(req.user.id) }); }
  catch (error) { next(error); }
};
export const errorHandler = (error, req, res, next) => {
  const status = error.code === 'P2002' ? 409 : error.code === 'FORBIDDEN' ? 403 : 500;
  const message = status === 409 ? 'An account with this email already exists' : status === 403 ? 'Caregiver access required' : 'Caregiver service temporarily unavailable';
  res.status(status).json({ status: 'error', message });
};
