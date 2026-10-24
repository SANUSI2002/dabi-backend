// /api/v1/accounting/organizations/:organizationId/{settings,receivables}
// Settings: read with acct.view, changed by the finance controller. Receivables: read with acct.view,
// prepared and issued with acct.post; credit limits, holds and over-limit issuing need acct.approve;
// FX revaluation is the controller's. The services check each action.
import express from 'express';
import { z } from 'zod';
import { handle, validateEmr as check } from '../../emr/core/validate.js';
import { requireVersion } from '../../emr/core/concurrency.js';
import { send } from '../../emr/core/http.js';
import * as settings from '../settings/settings.service.js';
import * as ar from './receivables.service.js';
import * as documents from '../documents/documents.service.js';
import * as payers from './payers.service.js';
import { sendPdf } from '../documents/financePdf.js';

const org = { organizationId: z.uuid() };
const withId = { ...org, id: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const free = (max) => z.string().trim().max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])*$/u, 'Contains control characters');
const when = z.iso.datetime({ offset: true }).or(z.iso.date());
const money = z.number().min(0).max(1e13);
const body = (shape, params = org) => z.object({ params: z.object(params).strict(), query: noQuery, body: z.object(shape).strict() });
const changes = (shape, params = withId) => z.object({
  params: z.object(params).strict(), query: noQuery,
  body: z.object(shape).strict().refine((b) => Object.values(b).some((x) => x !== undefined), 'Send at least one field to change'),
});
const taxId = z.string().regex(/^[\w-]{1,60}$/);
const salesLine = z.object({
  id: z.string().max(60).optional(), accountNumber: z.number().int().min(1000).max(5999), description: text(300), qty: z.number().positive().max(1e7), unitPrice: money,
  taxRateId: taxId.optional(), taxRateIds: z.array(taxId).max(5).optional(),
}).strict();
const lines = z.array(salesLine).min(1).max(200);
const currency = z.string().regex(/^[A-Z]{3}$/);
const CUSTOMER_TYPES = ['Patient', 'NHIS', 'HMO', 'Corporate', 'Walk-in'];
const customer = {
  name: text(160), type: z.enum(CUSTOMER_TYPES), email: z.email().max(160).optional(), phone: free(30).optional(), address: free(300).optional(), city: free(80).optional(),
  currency: currency.optional(), paymentTermsDays: z.number().int().min(0).max(365).optional(), paymentTermId: z.string().max(60).optional(), creditLimit: money.optional(),
};
const cashMethod = z.enum(['Cash', 'Bank Transfer', 'POS', 'Cheque']);
const docKind = z.enum(['estimate', 'sales-order', 'invoice', 'credit-note', 'sales-receipt', 'refund-receipt']);

const sequence = z.object({ key: z.string().max(40), label: text(80), prefix: z.string().max(12), padding: z.number().int().min(1).max(10), next: z.number().int().min(1), example: z.string().max(40).optional() }).strict();
const paymentTerm = z.object({ id: z.string().max(60), name: text(80), netDays: z.number().int().min(0).max(365), eom: z.boolean(), discountPercent: z.number().min(0).max(50).optional(), discountDays: z.number().int().min(0).max(365).optional(), active: z.boolean() }).strict();
const reminderRule = z.object({ id: z.string().max(60), level: z.number().int().min(1).max(9), daysOverdue: z.number().int().min(1).max(365), tone: text(40), subject: text(200), body: text(2000), active: z.boolean() }).strict();

const v = {
  overview: z.object({ params: z.object(org).strict(), query: noQuery }),
  settings: changes({
    org: z.object({
      legalName: free(160), tradingName: free(160), tin: free(40), rcNumber: free(40), address: free(300), reportingCurrency: currency, fiscalYearStartMonth: z.number().int().min(1).max(12),
      email: z.email().max(160).or(z.literal('')).optional(), phone: free(30).optional(), paymentInstructions: free(1000).optional(),
    }).strict().optional(),
    sequences: z.array(sequence).max(30).optional(), paymentTerms: z.array(paymentTerm).max(30).optional(), reminderRules: z.array(reminderRule).max(9).optional(),
    taxRegistration: z.object({ vatTin: free(40), wht: z.boolean(), payeStateId: free(40), vatRegistered: z.boolean() }).strict().optional(),
    setupSteps: z.record(z.string().max(30), z.boolean()).optional(),
  }, org),
  taxRate: body({ id: taxId.optional(), name: text(80), kind: z.enum(['VAT', 'WHT', 'Exempt', 'Zero-rated']), rate: z.number().min(0).max(100), description: free(300).optional(), accountNumber: z.number().int().min(1000).max(5999), isCompound: z.boolean().optional() }),
  updateTaxRate: changes({ name: text(80).optional(), rate: z.number().min(0).max(100).optional(), description: free(300).optional(), isActive: z.boolean().optional() }, { ...org, id: taxId }),

  customer: body({ id: z.uuid().optional(), ...customer, openingBalance: money.optional() }),
  importCustomers: body({ rows: z.array(z.object({ ...customer, openingBalance: money.optional() }).strict()).min(1).max(500) }),
  updateCustomer: changes({ ...Object.fromEntries(Object.entries(customer).map(([k, s]) => [k, s.optional()])), creditHold: z.boolean().optional() }),
  estimate: body({ id: z.uuid().optional(), customerId: z.uuid(), date: when, expiryDays: z.number().int().min(1).max(365), lines, notes: free(2000).optional() }),
  salesOrder: body({ id: z.uuid().optional(), customerId: z.uuid(), date: when, lines, notes: free(2000).optional() }),
  updateDraft: changes({ date: when.optional(), dueDate: when.optional(), expiryDate: when.optional(), lines: lines.optional(), notes: free(2000).optional() }, { ...org, kind: docKind, id: z.uuid() }),
  estimateStatus: body({ status: z.enum(['Sent', 'Accepted', 'Declined', 'Expired']) }, withId),
  orderStatus: body({ status: z.enum(['Confirmed', 'Cancelled']) }, withId),
  convert: body({ to: z.enum(['sales-order', 'invoice']), newId: z.uuid().optional() }, { ...org, kind: z.enum(['estimate', 'sales-order']), id: z.uuid() }),
  invoice: body({
    id: z.uuid().optional(), customerId: z.uuid(), date: when, dueDate: when.optional(), lines: z.array(salesLine).max(200), notes: free(2000).optional(), salesOrderId: z.uuid().optional(),
    currency: currency.optional(), exchangeRate: z.number().positive().max(1e7).optional(), deferOverMonths: z.number().int().min(0).max(120).optional(),
    recurEveryMonths: z.number().int().min(1).max(24).optional(), recurEndDate: when.optional(), delayedChargeIds: z.array(z.uuid()).max(100).optional(), projectId: z.string().max(64).optional(),
    timeEntryIds: z.array(z.string().max(64)).max(200).optional(),
  }).refine((r) => r.body.lines.length || r.body.delayedChargeIds?.length || r.body.timeEntryIds?.length, 'Add at least one line, charge or time entry'),
  issue: body({ overrideCredit: z.boolean().optional() }, withId),
  void: body({}, { ...org, kind: z.enum(['invoice', 'sales-receipt', 'refund-receipt']), id: z.uuid() }),
  receipt: body({
    id: z.uuid().optional(), customerId: z.uuid(), date: when, method: z.enum(['Cash', 'Bank Transfer', 'POS', 'Cheque', 'NHIS Remittance']), depositAccountNumber: z.number().int(),
    amount: z.number().positive().max(1e13), allocations: z.array(z.object({ invoiceId: z.uuid(), amount: money, discount: money.optional() }).strict()).max(100),
    settlementRate: z.number().positive().max(1e7).optional(), reference: free(100).optional(), notes: free(2000).optional(),
  }),
  creditNote: body({ id: z.uuid().optional(), customerId: z.uuid(), invoiceId: z.uuid().optional(), date: when, lines, reason: text(500), notes: free(2000).optional() }),
  applyCredit: body({ invoiceId: z.uuid(), amount: z.number().positive().max(1e13) }, withId),
  refundCredit: body({ amount: z.number().positive().max(1e13), fromAccountNumber: z.number().int() }, withId),
  salesReceipt: body({ id: z.uuid().optional(), customerId: z.uuid().optional(), customerName: free(160).optional(), date: when, method: cashMethod, depositAccountNumber: z.number().int(), lines, notes: free(2000).optional() }),
  refundReceipt: body({ id: z.uuid().optional(), customerId: z.uuid(), date: when, method: cashMethod, fromAccountNumber: z.number().int(), lines, reason: text(500), notes: free(2000).optional() }),
  charge: body({ id: z.uuid().optional(), customerId: z.uuid(), date: when, accountNumber: z.number().int(), description: text(300), qty: z.number().positive().max(1e7), unitPrice: money, taxRateId: taxId.optional() }),
  removeCharge: body({}, withId),
  recognize: body({ period: z.string().regex(/^\d{4}-\d{2}$/) }, withId),
  run: body({ asOf: when }),
  revalue: body({ asOf: when, rates: z.record(currency, z.number().positive().max(1e7)) }),
  reminder: body({}, withId),
  reminders: body({}),
  statement: body({ from: when.optional(), to: when.optional() }, withId),
  statementRead: z.object({ params: z.object(withId).strict(), query: z.object({ from: when.optional(), to: when.optional(), format: z.enum(['json', 'pdf']).optional(), download: z.enum(['1']).optional() }).strict() }),
  invoicePdf: z.object({ params: z.object(withId).strict(), query: z.object({ download: z.enum(['1']).optional() }).strict() }),
  emailInvoice: body({ to: z.email().max(160).optional() }, withId),
  billPayer: body({ id: z.uuid().optional(), payerId: z.uuid(), amount: z.number().positive().max(1e13).optional(), authorizationCode: free(60).optional(), enrolleeNumber: free(60).optional() }, withId),
  reverseTransfer: body({}, withId),
  claim: body({ id: z.uuid().optional(), payerId: z.uuid(), periodStart: when, periodEnd: when, invoiceIds: z.array(z.uuid()).min(1).max(500).optional(), notes: free(2000).optional() }),
  updateClaim: changes({ invoiceIds: z.array(z.uuid()).min(1).max(500).optional(), notes: free(2000).optional() }),
  submitClaim: body({ reference: free(100).optional() }, withId),
  cancelClaim: body({}, withId),
  adjudicate: body({ date: when.optional(), items: z.array(z.object({ invoiceId: z.uuid(), approved: money, reason: free(300).optional(), action: z.enum(['write-off', 'rebill']).optional() }).strict()).min(1).max(500) }, withId),
  capitation: body({
    id: z.uuid().optional(), payerId: z.uuid(), startPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), months: z.number().int().min(1).max(24), enrollees: z.number().int().positive().max(10_000_000),
    ratePerEnrollee: z.number().positive().max(1e9), receivedDate: when, depositAccountNumber: z.number().int(), reference: free(100).optional(),
  }),
  recognizeCapitation: body({ asOf: when }),
  writeOff: body({ amount: z.number().positive().max(1e13).optional(), reason: text(500), date: when.optional() }, withId),
  recover: body({ amount: z.number().positive().max(1e13), date: when.optional(), depositAccountNumber: z.number().int(), reference: free(100).optional() }, withId),
  creditLoss: body({ asOf: when.optional(), rates: z.object({ patient: z.array(z.number().min(0).max(100)).length(5), payer: z.array(z.number().min(0).max(100)).length(5) }).strict(), post: z.boolean().optional() }),
};

export const settingsRoutes = express.Router({ mergeParams: true });
settingsRoutes.get('/', check(v.overview), handle(async (req, res) => send(res, await settings.overview(req.emr))));
settingsRoutes.patch('/', check(v.settings), handle(async (req, res) => send(res, await settings.saveSettings(req.emr, requireVersion(req), req.body))));
settingsRoutes.post('/tax-rates', check(v.taxRate), handle(async (req, res) => send(res, await settings.addTaxRate(req.emr, req.body), 201)));
settingsRoutes.patch('/tax-rates/:id', check(v.updateTaxRate), handle(async (req, res) => send(res, await settings.updateTaxRate(req.emr, req.params.id, requireVersion(req), req.body))));

export const receivableRoutes = express.Router({ mergeParams: true });
const r = (method, path, schema, fn, status = 200) => receivableRoutes[method](path, check(schema), handle(async (req, res) => send(res, await fn(req), status)));
r('get', '/', v.overview, (req) => ar.overview(req.emr));
r('post', '/customers', v.customer, (req) => ar.addCustomer(req.emr, req.body), 201);
r('post', '/customers/import', v.importCustomers, (req) => ar.importCustomers(req.emr, req.body.rows));
receivableRoutes.patch('/customers/:id', check(v.updateCustomer), handle(async (req, res) => send(res, await ar.updateCustomer(req.emr, req.params.id, requireVersion(req), req.body))));
r('post', '/customers/:id/statement', v.statement, (req) => ar.markStatementSent(req.emr, req.params.id, req.body));
receivableRoutes.get('/customers/:id/statement', check(v.statementRead), handle(async (req, res) => {
  const { from, to, format, download } = req.query;
  const result = await documents.partyStatement(req.emr, 'customer', req.params.id, { from, to, format });
  return format === 'pdf' ? sendPdf(res, result, { download: Boolean(download) }) : send(res, result);
}));
receivableRoutes.get('/invoices/:id/pdf', check(v.invoicePdf), handle(async (req, res) => sendPdf(res, await documents.invoicePdf(req.emr, req.params.id), { download: Boolean(req.query.download) })));
r('post', '/invoices/:id/email', v.emailInvoice, (req) => ar.emailInvoice(req.emr, req.params.id, req.body));
// healthcare payers: billing HMOs and NHIA, claims, capitation; write-offs and the credit-loss allowance
r('get', '/payers', v.overview, (req) => payers.payersOverview(req.emr));
r('post', '/invoices/:id/bill-payer', v.billPayer, (req) => payers.billToPayer(req.emr, req.params.id, req.body), 201);
r('post', '/payer-transfers/:id/reverse', v.reverseTransfer, (req) => payers.reverseTransfer(req.emr, req.params.id));
r('post', '/claims', v.claim, (req) => payers.createClaim(req.emr, req.body), 201);
receivableRoutes.patch('/claims/:id', check(v.updateClaim), handle(async (req, res) => send(res, await payers.updateClaim(req.emr, req.params.id, requireVersion(req), req.body))));
r('post', '/claims/:id/submit', v.submitClaim, (req) => payers.submitClaim(req.emr, req.params.id, req.body));
r('post', '/claims/:id/cancel', v.cancelClaim, (req) => payers.cancelClaim(req.emr, req.params.id));
r('post', '/claims/:id/adjudicate', v.adjudicate, (req) => payers.adjudicateClaim(req.emr, req.params.id, req.body));
r('post', '/capitation', v.capitation, (req) => payers.recordCapitation(req.emr, req.body), 201);
r('post', '/capitation/recognize', v.recognizeCapitation, (req) => payers.recognizeCapitation(req.emr, req.body));
r('post', '/invoices/:id/write-off', v.writeOff, (req) => payers.writeOffInvoice(req.emr, req.params.id, req.body), 201);
r('post', '/write-offs/:id/recover', v.recover, (req) => payers.recoverWriteOff(req.emr, req.params.id, req.body));
r('post', '/credit-loss', v.creditLoss, (req) => payers.creditLoss(req.emr, req.body));
r('post', '/estimates', v.estimate, (req) => ar.createEstimate(req.emr, req.body), 201);
r('post', '/estimates/:id/status', v.estimateStatus, (req) => ar.setEstimateStatus(req.emr, req.params.id, req.body));
r('post', '/sales-orders', v.salesOrder, (req) => ar.createSalesOrder(req.emr, req.body), 201);
r('post', '/sales-orders/:id/status', v.orderStatus, (req) => ar.setOrderStatus(req.emr, req.params.id, req.body));
r('post', '/:kind/:id/convert', v.convert, (req) => ar.convertDoc(req.emr, req.params.kind, req.params.id, req.body), 201);
receivableRoutes.patch('/docs/:kind/:id', check(v.updateDraft), handle(async (req, res) => send(res, await ar.updateDraftDoc(req.emr, req.params.kind, req.params.id, requireVersion(req), req.body))));
r('post', '/invoices', v.invoice, (req) => ar.createInvoice(req.emr, req.body), 201);
r('post', '/invoices/:id/issue', v.issue, (req) => ar.issueInvoice(req.emr, req.params.id, req.body));
r('post', '/invoices/:id/reminder', v.reminder, (req) => ar.sendReminder(req.emr, req.params.id));
r('post', '/invoices/recurring/run', v.run, (req) => ar.runRecurringInvoices(req.emr, req.body));
r('post', '/reminders/run', v.reminders, (req) => ar.runReminders(req.emr));
r('post', '/revaluation', v.revalue, (req) => ar.revalueForeign(req.emr, req.body));
r('post', '/void/:kind/:id', v.void, (req) => ar.voidDoc(req.emr, req.params.kind, req.params.id));
r('post', '/receipts', v.receipt, (req) => ar.recordReceipt(req.emr, req.body), 201);
r('post', '/credit-notes', v.creditNote, (req) => ar.createCreditNote(req.emr, req.body), 201);
r('post', '/credit-notes/:id/apply', v.applyCredit, (req) => ar.applyCreditNote(req.emr, req.params.id, req.body));
r('post', '/credit-notes/:id/refund', v.refundCredit, (req) => ar.refundCreditNote(req.emr, req.params.id, req.body));
r('post', '/sales-receipts', v.salesReceipt, (req) => ar.createSalesReceipt(req.emr, req.body), 201);
r('post', '/refund-receipts', v.refundReceipt, (req) => ar.createRefundReceipt(req.emr, req.body), 201);
r('post', '/delayed-charges', v.charge, (req) => ar.addDelayedCharge(req.emr, req.body), 201);
r('post', '/delayed-charges/:id/remove', v.removeCharge, (req) => ar.removeDelayedCharge(req.emr, req.params.id));
r('post', '/revenue-schedules/:id/recognize', v.recognize, (req) => ar.recognizeRevenue(req.emr, req.params.id, req.body));
