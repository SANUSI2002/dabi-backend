// /api/v1/emr/organizations/:organizationId/appointments
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (migration 20261019090000_emr_appointments):
//   reception, nurse, doctor: see, book, check in, mark no-show, cancel
//   hospital admin:           see
import express from 'express';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send, sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as v from './appointments.validator.js';
import * as appointments from './appointments.service.js';

export const appointmentRoutes = express.Router({ mergeParams: true });

appointmentRoutes.get('/', check(v.list), allow('appointment.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await appointments.listAppointments(req.emr, req.query) })));
appointmentRoutes.post('/', check(v.book), allow('appointment.manage'),
  handle(async (req, res) => sendResult(res, await appointments.bookAppointment(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
appointmentRoutes.post('/:appointmentId/check-in', check(v.transition), allow('appointment.manage'),
  handle(async (req, res) => send(res, await appointments.checkIn(req.emr, req.params.appointmentId, requireVersion(req)))));
appointmentRoutes.post('/:appointmentId/no-show', check(v.transition), allow('appointment.manage'),
  handle(async (req, res) => send(res, await appointments.markNoShow(req.emr, req.params.appointmentId, requireVersion(req)))));
appointmentRoutes.post('/:appointmentId/cancel', check(v.cancel), allow('appointment.manage'),
  handle(async (req, res) => send(res, await appointments.cancelAppointment(req.emr, req.params.appointmentId, requireVersion(req), req.body))));
