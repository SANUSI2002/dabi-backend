import * as service from './inventory.service.js';
const failure = (error, response, next) => error.code === 'NOT_FOUND' ? response.status(404).json({ status: 'error', message: 'Inventory resource not found' }) : next(error);
const handle = (action, status = 200) => async (req, res, next) => { try { const data = await action(req); return res.status(status).json({ status: 'success', ...(data === undefined ? {} : { data }) }); } catch (error) { return failure(error, res, next); } };
export const create = handle((req) => service.create(req.user.id, req.body), 201);
export const list = handle((req) => service.list(req.user.id, req.query));
export const update = handle((req) => service.update(req.user.id, req.params.id, req.body));
export const deactivate = handle((req) => service.deactivate(req.user.id, req.params.id));
export const discover = handle((req) => service.discover(req.user.id, req.params.id, req.query));
