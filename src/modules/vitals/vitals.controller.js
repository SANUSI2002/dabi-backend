import * as Vitals from './vitals.model.js';
export const listVitals = async (req, res, next) => { try { res.json({ status: 'success', data: await Vitals.list(req.user.id, req.query) }); } catch (error) { next(error); } };
export const createVital = async (req, res, next) => { try { res.status(201).json({ status: 'success', data: await Vitals.create(req.user.id, req.body) }); } catch (error) { next(error); } };
