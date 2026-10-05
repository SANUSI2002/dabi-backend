import express from 'express';
import { protect } from '../../middleware/authMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import * as v from './doctor-appointments.validator.js';
import * as s from './doctor-appointments.service.js';

// Error code -> [HTTP status, stable client code, message]
const ERRORS = {
  FORBIDDEN: [403, 'FORBIDDEN', 'This action needs a patient account or a verified doctor account'],
  NOT_FOUND: [404, 'NOT_FOUND', 'Not found'],
  SLOT_UNAVAILABLE: [409, 'SLOT_UNAVAILABLE', 'That time is no longer available. Please choose another slot.'],
  SLOT_TAKEN: [409, 'SLOT_UNAVAILABLE', 'That time is no longer available. Please choose another slot.'],
  SLOT_OVERLAP: [409, 'SLOT_OVERLAP', 'This time overlaps a slot you have already published'],
  SLOT_BOOKED: [409, 'SLOT_BOOKED', 'This slot has an active booking. Decline or cancel the appointment first.'],
  INVALID_STATE: [409, 'INVALID_STATE', 'The appointment is not in a state that allows this action'],
  TYPE_NOT_OFFERED: [400, 'TYPE_NOT_OFFERED', 'The doctor does not offer that consultation type for this slot'],
};

const handle = (work, created = false) => async (req, res, next) => {
  try {
    res.status(created ? 201 : 200).json({ status: 'success', data: await work(req) });
  } catch (error) {
    // P2002: another booking won the slot's unique index. P2034: serializable conflict — retry.
    const code = error.code === 'P2002' ? 'SLOT_TAKEN' : error.code;
    if (error.code === 'P2034') return res.status(409).json({ status: 'error', code: 'CONFLICT', message: 'Something changed at the same time. Please try again.' });
    const known = ERRORS[code];
    if (!known) return next(error);
    return res.status(known[0]).json({ status: 'error', code: known[1], message: known[2] });
  }
};

const router = express.Router();
router.use(protect);

// ---------------- Patient ----------------
router.get('/doctors/:doctorId/slots', validate(v.doctorSlots), handle((q) => s.doctorSlots(q.params.doctorId, q.query)));
router.post('/', validate(v.book), handle((q) => s.book(q.user.id, q.body), true));
router.get('/mine', validate(v.mine), handle((q) => s.mine(q.user.id, q.query)));

// ---------------- Doctor workspace ----------------
router.get('/practice/profile', handle((q) => s.practiceProfile(q.user.id)));
router.patch('/practice/profile', validate(v.practiceProfile), handle((q) => s.updatePracticeProfile(q.user.id, q.body)));
router.get('/practice/slots', validate(v.practiceSlots), handle((q) => s.practiceSlots(q.user.id, q.query)));
router.post('/practice/slots', validate(v.createSlots), handle((q) => s.createSlots(q.user.id, q.body), true));
router.delete('/practice/slots/:id', validate(v.slotId), handle((q) => s.cancelSlot(q.user.id, q.params.id)));
router.get('/practice/appointments', validate(v.practiceQueue), handle((q) => s.practiceQueue(q.user.id, q.query)));
router.get('/practice/appointments/:id', validate(v.appointmentId), handle((q) => s.practiceAppointmentDetail(q.user.id, q.params.id)));
router.post('/practice/appointments/:id/confirm', validate(v.confirm), handle((q) => s.confirm(q.user.id, q.params.id, q.body)));
router.patch('/practice/appointments/:id/meeting-link', validate(v.meetingLink), handle((q) => s.setMeetingLink(q.user.id, q.params.id, q.body)));
router.post('/practice/appointments/:id/decline', validate(v.decline), handle((q) => s.decline(q.user.id, q.params.id, q.body)));
router.post('/practice/appointments/:id/cancel', validate(v.doctorCancel), handle((q) => s.doctorCancel(q.user.id, q.params.id, q.body)));
router.post('/practice/appointments/:id/complete', validate(v.complete), handle((q) => s.complete(q.user.id, q.params.id)));

// Patient routes with an :id come last so they can't shadow /practice/*.
router.get('/:id', validate(v.appointmentId), handle((q) => s.detail(q.user.id, q.params.id)));
router.post('/:id/cancel', validate(v.patientCancel), handle((q) => s.patientCancel(q.user.id, q.params.id, q.body)));
router.post('/:id/reschedule', validate(v.reschedule), handle((q) => s.reschedule(q.user.id, q.params.id, q.body)));

router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  return res.status(500).json({ status: 'error', message: 'Doctor appointments temporarily unavailable' });
});

export default router;
