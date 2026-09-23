import * as service from './family-care.calendar.service.js';
const handle = (upcoming) => async (req, res, next) => {
  try { res.json({ status: 'success', data: await service.read(req.user.id, req.query, upcoming) }); }
  catch (error) {
    if (error.code === 'FORBIDDEN') return res.status(403).json({ status: 'error', message: 'Patient calendar access required' });
    if (error.code === 'NOT_FOUND') return res.status(404).json({ status: 'error', message: 'Calendar scope not found' });
    if (error.code === 'P2034') return res.status(409).json({ status: 'error', message: 'Calendar access changed; refresh and retry' });
    next(error);
  }
};
export const calendar = handle(false);
export const upcoming = handle(true);
export const readOnly = (req, res) => res.set('Allow', 'GET').status(405).json({ status: 'error', message: 'Care Calendar is read-only' });
