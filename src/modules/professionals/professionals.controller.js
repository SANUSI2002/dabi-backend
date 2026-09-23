import * as P from './professionals.model.js';
const admin = async (req, res, next) => { try { if (!await P.isSuperAdmin(req.user.id)) return res.status(403).json({ status: 'error', message: 'Not authorized' }); return next(); } catch (e) { return next(e); } };
const handle = (e, res, next) => e.code === 'SELF' ? res.status(403).json({ status: 'error', message: 'Not authorized' }) : e.code === 'NOT_FOUND' || e.code === 'INVALID' ? res.status(404).json({ status: 'error', message: 'Professional not found' }) : next(e);
export { admin };
export const register = async (req, res, next) => { try { res.status(201).json({ status: 'success', data: await P.register(req.body) }); } catch (e) { if (e.code === 'P2002') return res.status(409).json({ status: 'error', message: 'Registration already exists' }); return next(e); } };
export const mine = async (req, res, next) => { try { const data = await P.mine(req.user.id); return data ? res.json({ status: 'success', data }) : res.status(404).json({ status: 'error', message: 'Professional onboarding not found' }); } catch (e) { return next(e); } };
export const list = async (req, res, next) => { try { res.json({ status: 'success', data: await P.list(req.query) }); } catch (e) { next(e); } };
const decision = (status) => async (req, res, next) => { try { res.json({ status: 'success', data: await P.decide(req.user.id, req.params.id, status, req.body.reason) }); } catch (e) { handle(e, res, next); } };
export const approve = decision('VERIFIED'); export const reject = decision('REJECTED'); export const suspend = decision('SUSPENDED'); export const reactivate = decision('PENDING');
