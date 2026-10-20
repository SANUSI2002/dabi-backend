// /api/v1/accounting/organizations/:organizationId/{banking,expenses}
// Banking: read with acct.view; transactions, statements, rules and reconciliations with acct.post; a new
// ledger account for a bank is the controller's. Live bank feeds are refused (no provider configured).
// Expense claims: read with acct.view, prepared, submitted and paid with acct.post; approval steps are
// decided by whoever holds the step's finance role (never the submitter). The services check each action.
import express from 'express';
import { z } from 'zod';
import { handle, validateEmr as check } from '../../emr/core/validate.js';
import { requireVersion } from '../../emr/core/concurrency.js';
import { send } from '../../emr/core/http.js';
import * as bank from './banking.service.js';
import * as exp from '../expenses/expenses.service.js';

const org = { organizationId: z.uuid() };
const withId = { ...org, id: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const free = (max) => z.string().trim().max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])*$/u, 'Contains control characters');
const when = z.iso.datetime({ offset: true }).or(z.iso.date());
const amount = z.number().positive().max(1e13);
const accountNumber = z.number().int().min(1000).max(9999);
const currency = z.string().regex(/^[A-Z]{3}$/);
const body = (shape, params = org) => z.object({ params: z.object(params).strict(), query: noQuery, body: z.object(shape).strict() });
const changes = (shape, params = withId) => z.object({
  params: z.object(params).strict(), query: noQuery,
  body: z.object(shape).strict().refine((b) => Object.values(b).some((x) => x !== undefined), 'Send at least one field to change'),
});
const rule = { accountNumber, name: text(120), descriptionContains: free(120).optional(), direction: z.enum(['in', 'out']).optional(), contraAccount: accountNumber, memo: free(200).optional() };
const PAY_MODES = ['Petty Cash', 'Bank — direct', 'Reimburse to staff'];
const expenseLine = z.object({ id: z.string().max(60).optional(), accountNumber, description: text(300), amount: z.number().min(0).max(1e13), taxRateId: z.string().regex(/^[\w-]{1,60}$/).optional() }).strict();
const claim = {
  claimantId: z.uuid().optional(), date: when, title: text(200), costCenter: free(120).optional(), payMode: z.enum(PAY_MODES), paidFromAccount: accountNumber.optional(),
  lines: z.array(expenseLine).min(1).max(100), receiptRef: free(100).optional(),
};

const v = {
  overview: z.object({ params: z.object(org).strict(), query: noQuery }),
  account: body({ number: accountNumber, name: text(160), bankName: text(120), accountName: text(160), accountNo: text(40), currency: currency.optional(), sortCode: free(20).optional(), subtype: z.enum(['bank', 'cash']), openingBalance: z.number().min(-1e13).max(1e13).optional() }),
  updateAccount: changes({ bankName: text(120).optional(), accountName: text(160).optional(), accountNo: text(40).optional(), currency: currency.optional(), sortCode: free(20).optional(), active: z.boolean().optional() }),
  transfer: body({ id: z.uuid().optional(), fromAccount: accountNumber, toAccount: accountNumber, amount, date: when, reference: free(100).optional(), note: free(300).optional() }),
  line: body({ accountNumber, contraAccount: accountNumber, direction: z.enum(['in', 'out']), amount, date: when, description: text(300), reference: free(100).optional() }),
  import: body({ accountNumber, lines: z.array(z.object({ date: when, description: text(300), amount: z.number().min(-1e13).max(1e13), reference: free(100).optional() }).strict()).min(1).max(2000) }),
  match: body({ matchedJournalEntryId: z.uuid().optional() }, withId),
  book: body({ contraAccount: accountNumber }, withId),
  rule: body({ id: z.uuid().optional(), ...rule }),
  updateRule: changes({ name: text(120).optional(), descriptionContains: free(120).optional(), direction: z.enum(['in', 'out']).nullable().optional(), contraAccount: accountNumber.optional(), memo: free(200).optional(), active: z.boolean().optional() }),
  applyRules: body({}, { ...org, number: z.coerce.number().int().min(1000).max(9999) }),
  recon: body({ id: z.uuid().optional(), accountNumber, statementDate: when, closingBalance: z.number().min(-1e13).max(1e13) }),
  toggle: body({ movementKey: z.string().regex(/^[\w-]{1,64}:[\w-]{1,64}$/) }, withId),
  empty: body({}, withId),
  feed: body({ accountNumber: accountNumber.optional(), provider: z.string().max(20).optional() }),
  feedAction: body({}, { ...org, id: z.string().max(64) }),
  claim: body({ id: z.uuid().optional(), ...claim }),
  updateClaim: changes(Object.fromEntries(Object.entries(claim).filter(([k]) => k !== 'claimantId').map(([k, s]) => [k, s.optional()]))),
  decision: body({ decision: z.enum(['Approved', 'Rejected']), comment: free(500).optional() }, withId),
  pay: body({ fromAccount: accountNumber }, withId),
};

export const bankingRoutes = express.Router({ mergeParams: true });
const r = (router, method, path, schema, fn, status = 200) => router[method](path, check(schema), handle(async (req, res) => send(res, await fn(req), status)));
const versioned = (router, path, schema, fn) => router.patch(path, check(schema), handle(async (req, res) => send(res, await fn(req, requireVersion(req)))));
r(bankingRoutes, 'get', '/', v.overview, (req) => bank.overview(req.emr));
r(bankingRoutes, 'post', '/accounts', v.account, (req) => bank.addBankAccount(req.emr, req.body), 201);
versioned(bankingRoutes, '/accounts/:id', v.updateAccount, (req, version) => bank.updateBankAccount(req.emr, req.params.id, version, req.body));
r(bankingRoutes, 'post', '/accounts/:number/apply-rules', v.applyRules, (req) => bank.applyRules(req.emr, Number(req.params.number)));
r(bankingRoutes, 'post', '/transfers', v.transfer, (req) => bank.recordTransfer(req.emr, req.body), 201);
r(bankingRoutes, 'post', '/transactions', v.line, (req) => bank.recordBankLine(req.emr, req.body), 201);
r(bankingRoutes, 'post', '/statement-lines/import', v.import, (req) => bank.importStatementLines(req.emr, req.body), 201);
r(bankingRoutes, 'post', '/statement-lines/:id/match', v.match, (req) => bank.matchStatementLine(req.emr, req.params.id, req.body));
r(bankingRoutes, 'post', '/statement-lines/:id/book', v.book, (req) => bank.bookStatementLine(req.emr, req.params.id, req.body));
r(bankingRoutes, 'post', '/rules', v.rule, (req) => bank.addRule(req.emr, req.body), 201);
versioned(bankingRoutes, '/rules/:id', v.updateRule, (req, version) => bank.updateRule(req.emr, req.params.id, version, req.body));
r(bankingRoutes, 'post', '/reconciliations', v.recon, (req) => bank.startReconciliation(req.emr, req.body), 201);
r(bankingRoutes, 'post', '/reconciliations/:id/toggle', v.toggle, (req) => bank.toggleCleared(req.emr, req.params.id, req.body));
r(bankingRoutes, 'post', '/reconciliations/:id/complete', v.empty, (req) => bank.completeReconciliation(req.emr, req.params.id));
r(bankingRoutes, 'post', '/connections', v.feed, (req) => bank.bankFeedUnavailable(req.emr));
r(bankingRoutes, 'post', '/connections/:id/sync', v.feedAction, (req) => bank.bankFeedUnavailable(req.emr));

export const expenseRoutes = express.Router({ mergeParams: true });
r(expenseRoutes, 'get', '/', v.overview, (req) => exp.overview(req.emr));
r(expenseRoutes, 'post', '/', v.claim, (req) => exp.createClaim(req.emr, req.body), 201);
versioned(expenseRoutes, '/:id', v.updateClaim, (req, version) => exp.updateClaim(req.emr, req.params.id, version, req.body));
r(expenseRoutes, 'post', '/:id/submit', v.empty, (req) => exp.submitClaim(req.emr, req.params.id));
r(expenseRoutes, 'post', '/:id/decide', v.decision, (req) => exp.decideClaim(req.emr, req.params.id, req.body));
r(expenseRoutes, 'post', '/:id/pay', v.pay, (req) => exp.payClaim(req.emr, req.params.id, req.body));
r(expenseRoutes, 'post', '/:id/discard', v.empty, (req) => exp.discardDraft(req.emr, req.params.id));
