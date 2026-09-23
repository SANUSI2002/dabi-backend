import * as Medications from './medications.model.js';
const handle = (error, res, next) => error.code === 'NOT_FOUND' ? res.status(404).json({ status: 'error', message: 'Medication not found' }) : next(error);
export const listMedications = async (req, res, next) => { try { res.json({ status: 'success', data: await Medications.list(req.user.id, req.query) }); } catch (error) { next(error); } };
export const getMedication = async (req, res, next) => { try { const data = await Medications.getById(req.user.id, req.params.id); if (!data) return res.status(404).json({ status: 'error', message: 'Medication not found' }); return res.json({ status: 'success', data }); } catch (error) { return next(error); } };
export const createMedication = async (req, res, next) => { try { res.status(201).json({ status: 'success', data: await Medications.create(req.user.id, req.body) }); } catch (error) { next(error); } };
export const updateMedication = async (req, res, next) => { try { res.json({ status: 'success', data: await Medications.update(req.user.id, req.params.id, req.body) }); } catch (error) { handle(error, res, next); } };
export const setMedicationAdherence = async (req, res, next) => { try { res.json({ status: 'success', data: await Medications.setAdherence(req.user.id, req.params.id, req.body.isTaken) }); } catch (error) { handle(error, res, next); } };
export const deleteMedication = async (req, res, next) => { try { await Medications.remove(req.user.id, req.params.id); res.json({ status: 'success' }); } catch (error) { handle(error, res, next); } };
