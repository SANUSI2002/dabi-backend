// /api/v1/emr/organizations/:organizationId/deliveries and /births
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (migration 20261026090000_emr_deliveries):
//   doctor, nurse:  see, record deliveries, mark one entered-in-error, notify/register births, record certificates
//   hospital admin: see; notify/register births and record certificates
import express from 'express';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send, sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as v from './deliveries.validator.js';
import * as deliveries from './deliveries.service.js';

export const deliveryRoutes = express.Router({ mergeParams: true });
deliveryRoutes.get('/', check(v.listDeliveries), allow('delivery.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await deliveries.listDeliveries(req.emr, req.query) })));
deliveryRoutes.post('/', check(v.recordDelivery), allow('delivery.record'),
  handle(async (req, res) => sendResult(res, await deliveries.recordDelivery(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
deliveryRoutes.post('/:deliveryId/entered-in-error', check(v.deliveryError), allow('delivery.record'),
  handle(async (req, res) => send(res, await deliveries.markDeliveryEnteredInError(req.emr, req.params.deliveryId, req.body))));
deliveryRoutes.post('/:deliveryId/birth-notification', check(v.notify), allow('birth.register'),
  handle(async (req, res) => sendResult(res, await deliveries.notifyBirth(req.emr, req.params.deliveryId, req.body, { idempotencyKey: readIdempotencyKey(req) }))));

export const birthRoutes = express.Router({ mergeParams: true });
birthRoutes.get('/', check(v.listRegister), allow('delivery.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await deliveries.listBirthRegister(req.emr, req.query) })));
birthRoutes.post('/:registrationId/register', check(v.register), allow('birth.register'),
  handle(async (req, res) => send(res, await deliveries.registerBirth(req.emr, req.params.registrationId, requireVersion(req), req.body))));
birthRoutes.post('/:registrationId/certificate', check(v.certificate), allow('birth.register'),
  handle(async (req, res) => send(res, await deliveries.recordCertificateIssued(req.emr, req.params.registrationId, requireVersion(req)))));
