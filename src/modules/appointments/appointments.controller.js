import * as Appointments from './appointments.model.js';
const handle = (error, res, next) => error.code === 'NOT_FOUND' ? res.status(404).json({ status: 'error', message: 'Appointment not found' }) : next(error);
export const listAppointments = async (req, res, next) => { try { res.json({ status: 'success', data: await Appointments.list(req.user.id, req.query) }); } catch (error) { next(error); } };
export const getAppointment = async (req, res, next) => { try { const data = await Appointments.getById(req.user.id, req.params.id); if (!data) return res.status(404).json({ status: 'error', message: 'Appointment not found' }); return res.json({ status: 'success', data }); } catch (error) { return next(error); } };
export const createAppointment = async (req, res, next) => { try { res.status(201).json({ status: 'success', data: await Appointments.create(req.user.id, req.body) }); } catch (error) { next(error); } };
export const updateAppointment = async (req, res, next) => { try { res.json({ status: 'success', data: await Appointments.update(req.user.id, req.params.id, req.body) }); } catch (error) { handle(error, res, next); } };
export const cancelAppointment = async (req, res, next) => { try { res.json({ status: 'success', data: await Appointments.cancel(req.user.id, req.params.id) }); } catch (error) { handle(error, res, next); } };
