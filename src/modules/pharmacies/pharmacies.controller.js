import * as service from './pharmacies.service.js';
const failure = (error, response, next) => { if (error.code === 'NOT_FOUND') return response.status(404).json({ status: 'error', message: 'Pharmacy not found' }); if (error.code === 'INVALID') return response.status(409).json({ status: 'error', message: 'Invalid pharmacy compliance transition' }); if (error.code === 'P2002' || error.code === 'ID_COLLISION') return response.status(409).json({ status: 'error', message: 'Pharmacy registration could not be completed' }); return next(error); };
const handle = (action, success = 200) => async (req, res, next) => { try { const data = await action(req); return res.status(success).json({ status: 'success', ...(data === undefined ? {} : { data }) }); } catch (error) { return failure(error, res, next); } };
export const register = handle((req) => service.register(req.body), 201);
export const mine = handle((req) => service.mine(req.user.id));
export const publicList = handle((req) => service.publicList(req.query));
export const publicDetail = handle(async (req) => { const pharmacy = await service.publicDetail(req.params.id); if (!pharmacy) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }); return pharmacy; });
export const complianceList = handle((req) => service.complianceList(req.user.id, req.query));
export const decision = handle((req) => service.decision(req.user.id, req.params.id, req.body));
