import * as service from './checkout-pricing.service.js';

const failure = (error, response, next) => {
  if (error.code === 'FORBIDDEN') return response.status(403).json({ status: 'error', message: 'Not authorized' });
  if (error.code === 'NOT_FOUND') return response.status(404).json({ status: 'error', message: 'Reservation not found' });
  if (error.code === 'INVALID') return response.status(400).json({ status: 'error', message: 'Checkout preview cannot be calculated' });
  return next(error);
};

const handle = (action, status = 200) => async (req, res, next) => {
  try {
    return res.status(status).json({ status: 'success', data: await action(req) });
  } catch (error) {
    return failure(error, res, next);
  }
};

export const current = handle((req) => service.readConfiguration(req.user.id));
export const update = handle((req) => service.updateConfiguration(req.user.id, req.body));
export const preview = handle((req) => service.preview(
  req.user.id,
  req.params.id,
  req.body.fulfilments,
  req.body.deliveryCoordinates,
));
