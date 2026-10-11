import * as service from './checkout-pricing.service.js';

const failure = (error, response, next) => {
  if (error.code === 'FORBIDDEN') return response.status(403).json({ status: 'error', message: 'Not authorized' });
  if (error.code === 'NOT_FOUND') return response.status(404).json({ status: 'error', message: 'Reservation not found' });
  if (error.code === 'INVALID') return response.status(400).json({ status: 'error', message: 'Checkout preview cannot be calculated' });
  // Delivery pricing outcomes the patient can act on (see delivery-pricing.js and distance.js).
  if (['NOT_SERVICEABLE', 'INVALID_ORIGIN'].includes(error.code)) return response.status(422).json({ status: 'error', code: error.code, message: error.message, details: error.details });
  if (error.code === 'INVALID_DESTINATION' || error.code === 'INVALID_DISTANCE') return response.status(400).json({ status: 'error', code: error.code, message: error.message });
  if (error.code === 'ROUTE_DISTANCE_UNAVAILABLE') return response.status(503).json({ status: 'error', code: error.code, message: error.message });
  if (['INVALID_PRICING', 'REASON_REQUIRED'].includes(error.code)) return response.status(400).json({ status: 'error', code: error.code, message: error.message });
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
