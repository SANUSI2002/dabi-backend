import * as service from './prescriptions.service.js';

const failure = (error, response, next) => {
  if (error.code === 'NOT_FOUND') return response.status(404).json({ status: 'error', message: 'Prescription not found' });
  return next(error);
};
const handle = (action, success = 200) => async (req, res, next) => { try { const data = await action(req); return res.status(success).json({ status: 'success', ...(data === undefined ? {} : { data }) }); } catch (error) { return failure(error, res, next); } };
export const createDraft = handle((req) => service.createDraft(req.user.id, req.body), 201);
export const updateDraft = handle((req) => service.updateDraft(req.user.id, req.params.id, req.body));
export const issue = handle((req) => service.issue(req.user.id, req.params.id));
export const cancel = handle(async (req) => service.cancel(req.user.id, req.params.id));
export const patientList = handle((req) => service.patientList(req.user.id, req.query));
export const doctorList = handle((req) => service.doctorList(req.user.id, req.query));
export const read = handle(async (req) => { const prescription = await service.read(req.user.id, req.params.id); if (!prescription) { const error = Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }); throw error; } return prescription; });
