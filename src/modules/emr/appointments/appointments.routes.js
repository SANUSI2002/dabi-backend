// /api/v1/emr/organizations/:organizationId/appointments
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (migration 20261019090000_emr_appointments):
//   reception, nurse, doctor: see, book, check in, mark no-show, cancel
//   hospital admin:           see
// Requests patients make in the Sabi app (migration 20261019120000_emr_appointment_requests): the
// same people see them and confirm (which books the patient in) or reject them. A request is
// decided once, so confirm/reject need no If-Match; confirm takes an Idempotency-Key like booking.
import express from 'express';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send, sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as v from './appointments.validator.js';
import * as appointments from './appointments.service.js';
import * as requests from './appointment-requests.service.js';

export const appointmentRoutes = express.Router({ mergeParams: true });

appointmentRoutes.get('/', check(v.list), allow('appointment.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await appointments.listAppointments(req.emr, req.query) })));
appointmentRoutes.get('/requests', check(v.listRequests), allow('appointment.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await requests.listRequests(req.emr, req.query) })));
appointmentRoutes.post('/requests/:requestId/confirm', check(v.confirmRequest), allow('appointment.manage'),
  handle(async (req, res) => sendResult(res, await requests.confirmRequest(req.emr, req.params.requestId, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
appointmentRoutes.post('/requests/:requestId/reject', check(v.rejectRequest), allow('appointment.manage'),
  handle(async (req, res) => send(res, await requests.rejectRequest(req.emr, req.params.requestId, req.body))));
appointmentRoutes.post('/', check(v.book), allow('appointment.manage'),
  handle(async (req, res) => sendResult(res, await appointments.bookAppointment(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
appointmentRoutes.post('/:appointmentId/check-in', check(v.transition), allow('appointment.manage'),
  handle(async (req, res) => send(res, await appointments.checkIn(req.emr, req.params.appointmentId, requireVersion(req)))));
appointmentRoutes.post('/:appointmentId/no-show', check(v.transition), allow('appointment.manage'),
  handle(async (req, res) => send(res, await appointments.markNoShow(req.emr, req.params.appointmentId, requireVersion(req)))));
appointmentRoutes.post('/:appointmentId/cancel', check(v.cancel), allow('appointment.manage'),
  handle(async (req, res) => send(res, await appointments.cancelAppointment(req.emr, req.params.appointmentId, requireVersion(req), req.body))));
