import { Buffer } from 'node:buffer';
import * as service from './organisations.service.js';
const failure = (error, res, next) => {
  if (error.code === 'NOT_FOUND') return res.status(404).json({ status: 'error', message: 'Organisation not found' });
  if (error.code === 'INVALID' || error.code === 'P2034') return res.status(409).json({ status: 'error', message: 'Organisation state changed or transition is invalid' });
  if (error.code === 'P2002' || error.code === 'ID_COLLISION') return res.status(409).json({ status: 'error', message: 'Registration could not be completed' });
  return next(error);
};
const handle = (work, status = 200) => async (req, res, next) => { try { res.set('Cache-Control', 'no-store'); return res.status(status).json({ status: 'success', data: await work(req) }); } catch (error) { return failure(error, res, next); } };
export const register = handle((req) => service.register(req.body), 201);
export const mine = handle((req) => service.mine(req.user.id));
export const queue = handle((req) => service.queue(req.user.id, req.query));
export const detail = handle((req) => service.detail(req.user.id, req.params.id));
export const pharmacyDetail = handle((req) => service.pharmacyDetail(req.user.id, req.params.id));
export const decision = (action) => handle((req) => service.decision(req.user.id, req.params.id, action, req.body));
export const publicList = handle((req) => service.publicList(req.query));
export const publicDetail = handle((req) => service.publicDetail(req.params.id));
export const download = async (req, res, next) => {
  try {
    const document = await service.document(req.user.id, req.params.id, req.params.key);
    return res.set({ 'Cache-Control': 'no-store', 'Content-Type': document.contentType, 'Content-Disposition': 'attachment; filename="verification-document"', 'X-Content-Type-Options': 'nosniff' }).send(Buffer.from(document.content));
  } catch (error) { return failure(error, res, next); }
};
export const errorHandler = (error, req, res, next) => res.status(error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500).json({ status: 'error', message: error.type === 'entity.too.large' ? 'Registration documents exceed request size limit' : error.type === 'entity.parse.failed' ? 'Invalid JSON request' : 'Organisation service temporarily unavailable' });
