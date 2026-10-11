import * as service from './orders.service.js';

const failure = (error, response, next) => {
  if (error.code === 'FORBIDDEN') return response.status(403).json({ status: 'error', message: 'Not authorized' });
  if (error.code === 'NOT_FOUND') return response.status(404).json({ status: 'error', message: 'Order not found' });
  if (error.code === 'INVALID' || error.code === 'DELIVERY_ENCRYPTION_REQUIRED') {
    return response.status(400).json({ status: 'error', message: 'Order cannot be created' });
  }
  if (error.code === 'P2002') return response.status(409).json({ status: 'error', message: 'Order cannot be created' });
  if (error.code === 'PRICE_CHANGED') return response.status(409).json({ status: 'error', code: error.code, message: error.message, details: error.details });
  if (['NOT_SERVICEABLE', 'INVALID_ORIGIN'].includes(error.code)) return response.status(422).json({ status: 'error', code: error.code, message: error.message, details: error.details });
  if (error.code === 'INVALID_DESTINATION' || error.code === 'INVALID_DISTANCE') return response.status(400).json({ status: 'error', code: error.code, message: error.message });
  if (error.code === 'ROUTE_DISTANCE_UNAVAILABLE') return response.status(503).json({ status: 'error', code: error.code, message: error.message });
  return next(error);
};

export const create = async (req, res, next) => {
  try {
    const result = await service.create(req.user.id, req.body);
    return res.status(result.idempotent ? 200 : 201).json({ status: 'success', data: result.order });
  } catch (error) {
    return failure(error, res, next);
  }
};

const read = (action) => async (req, res, next) => {
  try {
    const data = await action(req);
    if (!data) return res.status(404).json({ status: 'error', message: 'Order not found' });
    return res.json({ status: 'success', data });
  } catch (error) {
    return failure(error, res, next);
  }
};

export const list = read((req) => service.list(req.user.id));
export const detail = read((req) => service.detail(req.user.id, req.params.id));
