// /api/v1/accounting/organizations/:organizationId/{payables,approval-rules}
// Payables: read with acct.view, prepared, submitted, posted and paid with acct.post; approval steps are
// decided by whoever holds the step's finance role (never the submitter); FX revaluation is the
// controller's. Approval rules are the controller's. The services check each action.
import express from 'express';
import { z } from 'zod';
import { handle, validateEmr as check } from '../../emr/core/validate.js';
import { requireVersion } from '../../emr/core/concurrency.js';
import { send } from '../../emr/core/http.js';
import * as ap from './payables.service.js';
import * as approvals from '../control/approvals.service.js';

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
const purchaseLine = z.object({
  id: z.string().max(60).optional(), accountNumber: z.number().int().min(1000).max(5999), description: text(300), qty: z.number().positive().max(1e7), unitPrice: money,
  taxRateId: taxId.optional(), taxRateIds: z.array(taxId).max(5).optional(), itemId: z.string().max(64).optional(),
}).strict();
const lines = z.array(purchaseLine).min(1).max(200);
const currency = z.string().regex(/^[A-Z]{3}$/);
const CATEGORIES = ['Pharmaceuticals', 'Medical Supplies', 'Equipment', 'Utilities', 'Services', 'Facilities', 'Other'];
const vendor = {
  name: text(160), email: z.email().max(160).optional(), phone: free(30).optional(), address: free(300).optional(), taxId: free(40).optional(), category: z.enum(CATEGORIES),
  currency: currency.optional(), paymentTermsDays: z.number().int().min(0).max(365).optional(), paymentTermId: z.string().max(60).optional(),
};
const decision = body({ decision: z.enum(['Approved', 'Rejected']), comment: free(500).optional() }, withId);
const DOC_TYPES = ['Purchase Requisition', 'Purchase Order', 'Bill', 'Vendor Payment', 'Expense Claim', 'Journal Entry'];
const ROLES = ['Accountant', 'Approver', 'Finance Controller'];

const v = {
  overview: z.object({ params: z.object(org).strict(), query: noQuery }),
  vendor: body({ id: z.uuid().optional(), ...vendor, openingBalance: money.optional() }),
  updateVendor: changes({ ...Object.fromEntries(Object.entries(vendor).map(([k, s]) => [k, s.optional()])), active: z.boolean().optional() }),
  requisition: body({ id: z.uuid().optional(), vendorId: z.uuid().optional(), department: free(120).optional(), date: when, needBy: when.optional(), lines, justification: text(2000) }),
  empty: body({}, withId),
  decision,
  convertPR: body({ vendorId: z.uuid(), newId: z.uuid().optional() }, withId),
  po: body({ id: z.uuid().optional(), vendorId: z.uuid(), date: when, expectedDate: when.optional(), lines, notes: free(2000).optional(), requisitionId: z.uuid().optional() }),
  poStatus: body({ status: z.enum(['Sent', 'Cancelled']) }, withId),
  receive: body({ id: z.uuid().optional(), received: z.array(z.object({ poLineId: z.string().max(60), qtyReceived: z.number().min(0).max(1e7) }).strict()).min(1).max(200), notes: free(2000).optional() }, withId),
  stocked: body({ poLineIds: z.array(z.string().max(60)).min(1).max(200) }, withId),
  convertPO: body({ newId: z.uuid().optional() }, withId),
  bill: body({
    id: z.uuid().optional(), vendorId: z.uuid(), vendorInvoiceNumber: free(60).optional(), date: when, dueDate: when.optional(), lines, notes: free(2000).optional(), purchaseOrderId: z.uuid().optional(),
    currency: currency.optional(), exchangeRate: z.number().positive().max(1e7).optional(), recurEveryMonths: z.number().int().min(1).max(24).optional(), recurEndDate: when.optional(), projectId: z.string().max(64).optional(),
  }),
  updateDraft: changes({ date: when.optional(), dueDate: when.optional(), vendorInvoiceNumber: free(60).optional(), lines: lines.optional(), notes: free(2000).optional() }, { ...org, kind: z.enum(['requisition', 'po', 'bill']), id: z.uuid() }),
  payment: body({
    id: z.uuid().optional(), vendorId: z.uuid(), date: when, method: z.enum(['Bank Transfer', 'Cheque', 'Cash']), fromAccountNumber: z.number().int(), amount: z.number().positive().max(1e13),
    allocations: z.array(z.object({ billId: z.uuid(), amount: money }).strict()).max(100), settlementRate: z.number().positive().max(1e7).optional(), reference: free(100).optional(), withheldTax: money.optional(),
  }),
  credit: body({ id: z.uuid().optional(), vendorId: z.uuid(), billId: z.uuid().optional(), date: when, lines, reason: text(500) }),
  applyCredit: body({ billId: z.uuid(), amount: z.number().positive().max(1e13) }, withId),
  run: body({ asOf: when }),
  revalue: body({ asOf: when, rates: z.record(currency, z.number().positive().max(1e7)) }),
  rule: body({ id: z.uuid().optional(), docType: z.enum(DOC_TYPES), minAmount: money, maxAmount: money.nullable(), approverRole: z.enum(ROLES), level: z.number().int().min(1).max(9) }),
  updateRule: changes({ minAmount: money.optional(), maxAmount: money.nullable().optional(), approverRole: z.enum(ROLES).optional(), level: z.number().int().min(1).max(9).optional(), active: z.boolean().optional() }),
};

export const payableRoutes = express.Router({ mergeParams: true });
const r = (method, path, schema, fn, status = 200) => payableRoutes[method](path, check(schema), handle(async (req, res) => send(res, await fn(req), status)));
r('get', '/', v.overview, (req) => ap.overview(req.emr));
r('post', '/vendors', v.vendor, (req) => ap.addVendor(req.emr, req.body), 201);
payableRoutes.patch('/vendors/:id', check(v.updateVendor), handle(async (req, res) => send(res, await ap.updateVendor(req.emr, req.params.id, requireVersion(req), req.body))));
r('post', '/requisitions', v.requisition, (req) => ap.createRequisition(req.emr, req.body), 201);
r('post', '/requisitions/:id/submit', v.empty, (req) => ap.submitRequisition(req.emr, req.params.id));
r('post', '/requisitions/:id/decide', v.decision, (req) => ap.decideRequisition(req.emr, req.params.id, req.body));
r('post', '/requisitions/:id/convert', v.convertPR, (req) => ap.convertRequisition(req.emr, req.params.id, req.body), 201);
r('post', '/purchase-orders', v.po, (req) => ap.createPurchaseOrder(req.emr, req.body), 201);
r('post', '/purchase-orders/:id/status', v.poStatus, (req) => ap.setOrderStatus(req.emr, req.params.id, req.body));
r('post', '/purchase-orders/:id/receive', v.receive, (req) => ap.receiveGoods(req.emr, req.params.id, req.body), 201);
r('post', '/purchase-orders/:id/bill', v.convertPO, (req) => ap.convertPO(req.emr, req.params.id, req.body), 201);
r('post', '/goods-receipts/:id/stocked', v.stocked, (req) => ap.markReceiptStocked(req.emr, req.params.id, req.body));
payableRoutes.patch('/docs/:kind/:id', check(v.updateDraft), handle(async (req, res) => send(res, await ap.updateDraftDoc(req.emr, req.params.kind, req.params.id, requireVersion(req), req.body))));
r('post', '/bills', v.bill, (req) => ap.createBill(req.emr, req.body), 201);
r('post', '/bills/:id/submit', v.empty, (req) => ap.submitBill(req.emr, req.params.id));
r('post', '/bills/:id/decide', v.decision, (req) => ap.decideBill(req.emr, req.params.id, req.body));
r('post', '/bills/:id/void', v.empty, (req) => ap.voidBill(req.emr, req.params.id));
r('post', '/bills/recurring/run', v.run, (req) => ap.runRecurringBills(req.emr, req.body));
r('post', '/payments', v.payment, (req) => ap.payVendor(req.emr, req.body), 201);
r('post', '/vendor-credits', v.credit, (req) => ap.createVendorCredit(req.emr, req.body), 201);
r('post', '/vendor-credits/:id/apply', v.applyCredit, (req) => ap.applyVendorCredit(req.emr, req.params.id, req.body));
r('post', '/revaluation', v.revalue, (req) => ap.revalueForeign(req.emr, req.body));

export const approvalRuleRoutes = express.Router({ mergeParams: true });
approvalRuleRoutes.post('/', check(v.rule), handle(async (req, res) => send(res, await approvals.addRule(req.emr, req.body), 201)));
approvalRuleRoutes.patch('/:id', check(v.updateRule), handle(async (req, res) => send(res, await approvals.updateRule(req.emr, req.params.id, requireVersion(req), req.body))));
