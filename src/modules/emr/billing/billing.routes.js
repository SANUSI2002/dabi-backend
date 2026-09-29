// Billing routes: /api/v1/emr/organizations/:organizationId/billing/...
//
// Who can do what (migration 20261003090000_emr_billing):
//   finance officer: prices, charges, invoices, discounts, voids, payments
//   reception (cashier): read, invoice, take payments
//   hospital admin: prices, discounts, voids, and payment reversals (never by the recorder)
import express from 'express';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { etagFor, requireVersion } from '../core/concurrency.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as v from './billing.validator.js';
import * as billing from './billing.service.js';
import { captureCharges } from './capture.service.js';

const send = (res, data, status = 200) => {
  if (data?.version) res.set('ETag', etagFor(data.version));
  res.status(status).json({ status: 'success', data });
};
const sendResult = (res, result) => {
  if (result.replayed) res.set('Idempotent-Replayed', 'true');
  send(res, result.body, result.statusCode);
};

export const billingRoutes = express.Router({ mergeParams: true });

billingRoutes.get('/prices', check(v.listPrices), allow('billing.read', 'billing.price.manage'),
  handle(async (req, res) => res.json({ status: 'success', data: { items: await billing.listPrices(req.emr, req.query) } })));
billingRoutes.post('/prices', check(v.createPrice), allow('billing.price.manage'),
  handle(async (req, res) => send(res, await billing.createPrice(req.emr, req.body), 201)));
billingRoutes.patch('/prices/:priceId', check(v.updatePrice), allow('billing.price.manage'),
  handle(async (req, res) => send(res, await billing.updatePrice(req.emr, req.params.priceId, requireVersion(req), req.body))));

billingRoutes.get('/encounters/:encounterId/charges', check(v.oneEncounter), allow('billing.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await billing.encounterCharges(req.emr, req.params.encounterId) })));
billingRoutes.post('/encounters/:encounterId/capture', check(v.capture), allow('billing.charge.manage', 'billing.invoice.create'),
  handle(async (req, res) => res.json({ status: 'success', data: await captureCharges(req.emr, req.params.encounterId) })));
billingRoutes.post('/encounters/:encounterId/charges', check(v.addCharge), allow('billing.charge.manage'),
  handle(async (req, res) => send(res, await billing.addCharge(req.emr, req.params.encounterId, req.body), 201)));
billingRoutes.post('/charges/:chargeId/void', check(v.voidCharge), allow('billing.charge.manage'),
  handle(async (req, res) => send(res, await billing.voidCharge(req.emr, req.params.chargeId, req.body))));

billingRoutes.post('/encounters/:encounterId/invoices', check(v.createInvoice), allow('billing.invoice.create'),
  handle(async (req, res) => sendResult(res, await billing.createInvoice(req.emr, req.params.encounterId, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
billingRoutes.get('/invoices', check(v.listInvoices), allow('billing.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await billing.listInvoices(req.emr, req.query) })));
billingRoutes.get('/invoices/:invoiceId', check(v.oneInvoice), allow('billing.read'),
  handle(async (req, res) => send(res, await billing.getInvoice(req.emr, req.params.invoiceId))));
billingRoutes.post('/invoices/:invoiceId/void', check(v.voidInvoice), allow('billing.invoice.void'),
  handle(async (req, res) => send(res, await billing.voidInvoice(req.emr, req.params.invoiceId, requireVersion(req), req.body))));
billingRoutes.post('/invoices/:invoiceId/payments', check(v.recordPayment), allow('billing.payment.record'),
  handle(async (req, res) => sendResult(res, await billing.recordPayment(req.emr, req.params.invoiceId, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
billingRoutes.post('/payments/:paymentId/reverse', check(v.reversePayment), allow('billing.payment.reverse'),
  handle(async (req, res) => send(res, await billing.reversePayment(req.emr, req.params.paymentId, req.body))));

billingRoutes.get('/patients/:patientId/statement', check(v.statement), allow('billing.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await billing.patientStatement(req.emr, req.params.patientId) })));
billingRoutes.get('/reconciliation', check(v.orgOnly), allow('billing.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await billing.reconciliation(req.emr) })));
