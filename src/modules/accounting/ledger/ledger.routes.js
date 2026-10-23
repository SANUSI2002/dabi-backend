// /api/v1/accounting/organizations/:organizationId/ledger — chart of accounts, branches, fiscal
// calendar and locks, journal entries, recurring journals, year-end close, trial balance.
// Who can do what (migration 20261118090000_accounting_ledger; the service checks each action):
//   acct.view      finance officer, hospital admin, owner, finance controller — read the books
//   acct.post      finance officer, owner, finance controller — prepare and post entries
//   acct.control   owner, finance controller — reverse, chart of accounts, branches, locks, year-end
import express from 'express';
import { z } from 'zod';
import { handle, validateEmr as check } from '../../emr/core/validate.js';
import { requireVersion } from '../../emr/core/concurrency.js';
import { send } from '../../emr/core/http.js';
import * as ledger from './ledger.service.js';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const free = (max) => z.string().trim().max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])*$/u, 'Contains control characters');
const when = z.iso.datetime({ offset: true }).or(z.iso.date());
const body = (shape, params = org) => z.object({ params: z.object(params).strict(), query: noQuery, body: z.object(shape).strict() });
const changes = (shape, params) => z.object({
  params: z.object(params).strict(), query: noQuery,
  body: z.object(shape).strict().refine((b) => Object.values(b).some((x) => x !== undefined), 'Send at least one field to change'),
});
const accountNumber = z.number().int().min(1000).max(5999);
const money = z.number().min(0).max(1e13);
const line = z.object({
  accountNumber, debit: money.default(0), credit: money.default(0), description: free(300).optional(), costCenter: free(60).optional(),
  customerId: z.string().max(64).optional(), vendorId: z.string().max(64).optional(), projectId: z.string().max(64).optional(),
}).strict();
const lines = z.array(line).min(2).max(200);
const TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense', 'cogs'];
const SUBTYPES = ['cash', 'bank', 'accounts_receivable', 'inventory', 'current_asset', 'fixed_asset', 'contra_asset', 'other_asset', 'accounts_payable', 'tax_payable',
  'current_liability', 'long_term_liability', 'equity', 'retained_earnings', 'operating_revenue', 'other_income', 'contra_revenue', 'cost_of_goods_sold', 'operating_expense',
  'payroll_expense', 'depreciation_expense', 'other_expense'];
const account = {
  number: accountNumber, name: text(120), type: z.enum(TYPES), subtype: z.enum(SUBTYPES), parentNumber: accountNumber.optional(), description: free(500).optional(),
  openingBalance: z.number().min(-1e13).max(1e13).optional(), allowManualEntry: z.boolean().optional(),
};
const withId = { ...org, id: z.uuid() };
const yearParam = { ...org, year: z.coerce.number().int().min(2000).max(2200) };

const v = {
  overview: z.object({ params: z.object(org).strict(), query: noQuery }),
  trialBalance: z.object({ params: z.object(org).strict(), query: z.object({ asOf: when.optional(), branchId: z.uuid().optional() }).strict() }),
  entry: body({ id: z.uuid().optional(), date: when, memo: text(500), reference: free(100).optional(), lines, status: z.enum(['Draft', 'Posted']).optional(), branchId: z.uuid().optional() }),
  updateDraft: changes({ date: when.optional(), memo: text(500).optional(), reference: free(100).optional(), lines: lines.optional() }, withId),
  empty: body({}, withId),
  decision: body({ decision: z.enum(['Approved', 'Rejected']), comment: free(500).optional() }, withId),
  reverse: body({ date: when.optional(), memo: text(500).optional() }, withId),
  account: body(account),
  import: body({ rows: z.array(z.object(account).strict()).min(1).max(500) }),
  template: body({ templateId: z.string().max(60) }),
  updateAccount: changes({
    name: text(120).optional(), subtype: z.enum(SUBTYPES).optional(), parentNumber: accountNumber.nullable().optional(), description: free(500).optional(),
    isActive: z.boolean().optional(), allowManualEntry: z.boolean().optional(),
  }, { ...org, number: z.coerce.number().int().min(1000).max(5999) }),
  branch: body({ id: z.uuid().optional(), code: z.string().trim().regex(/^[A-Za-z0-9]{2,12}$/), name: text(160) }),
  group: body({ id: z.uuid().optional(), name: text(120), branchIds: z.array(z.uuid()).min(1).max(50) }),
  period: body({ status: z.enum(['Open', 'Closed', 'Locked']) }, withId),
  lock: body({ booksLockedBefore: when.nullable() }),
  fx: body({ fxRates: z.array(z.object({ code: z.string().regex(/^[A-Z]{3}$/), name: text(60), symbol: z.string().max(4), rateToNgn: z.number().positive().max(1e7) }).strict()).min(1).max(30) }),
  year: body({ year: z.number().int().min(2000).max(2200) }),
  yearPreview: z.object({ params: z.object(yearParam).strict(), query: noQuery }),
  yearClose: body({}, yearParam),
  recurring: body({ id: z.uuid().optional(), memo: text(500), lines, everyMonths: z.number().int().min(1).max(24), startDate: when, endDate: when.optional() }),
  updateRecurring: changes({ memo: text(500).optional(), everyMonths: z.number().int().min(1).max(24).optional(), endDate: when.nullable().optional(), active: z.boolean().optional() }, withId),
  run: body({ asOf: when }),
};

export const ledgerRoutes = express.Router({ mergeParams: true });
const r = (method, path, schema, fn, status = 200) => ledgerRoutes[method](path, check(schema), handle(async (req, res) => send(res, await fn(req), status)));
const versioned = (method, path, schema, fn) => ledgerRoutes[method](path, check(schema), handle(async (req, res) => send(res, await fn(req, requireVersion(req)))));

r('get', '/', v.overview, (req) => ledger.overview(req.emr));
r('get', '/trial-balance', v.trialBalance, (req) => ledger.trialBalance(req.emr, req.query));
r('post', '/entries', v.entry, (req) => ledger.createEntry(req.emr, req.body), 201);
versioned('patch', '/entries/:id', v.updateDraft, (req, version) => ledger.updateDraft(req.emr, req.params.id, version, req.body));
versioned('post', '/entries/:id/post', v.empty, (req, version) => ledger.postDraft(req.emr, req.params.id, version));
// an approval step is decided by whoever holds its finance role, never the person who submitted it
r('post', '/entries/:id/decide', v.decision, (req) => ledger.decideEntry(req.emr, req.params.id, req.body));
versioned('post', '/entries/:id/void', v.empty, (req, version) => ledger.voidEntry(req.emr, req.params.id, version));
r('post', '/entries/:id/reverse', v.reverse, (req) => ledger.reverseEntry(req.emr, req.params.id, req.body), 201);
r('post', '/accounts', v.account, (req) => ledger.addAccount(req.emr, req.body), 201);
r('post', '/accounts/import', v.import, (req) => ledger.importAccounts(req.emr, req.body.rows));
r('post', '/accounts/template', v.template, (req) => ledger.applyTemplate(req.emr, req.body.templateId));
versioned('patch', '/accounts/:number', v.updateAccount, (req, version) => ledger.updateAccount(req.emr, req.params.number, version, req.body));
r('post', '/branches', v.branch, (req) => ledger.addBranch(req.emr, req.body), 201);
r('post', '/consolidation-groups', v.group, (req) => ledger.addConsolidationGroup(req.emr, req.body), 201);
r('post', '/periods/:id/status', v.period, (req) => ledger.setPeriodStatus(req.emr, req.params.id, req.body));
versioned('put', '/lock', v.lock, (req, version) => ledger.setBooksLock(req.emr, version, req.body));
versioned('put', '/fx-rates', v.fx, (req, version) => ledger.setFxRates(req.emr, version, req.body));
r('post', '/fiscal-years', v.year, (req) => ledger.openFiscalYear(req.emr, req.body), 201);
r('get', '/year-end/:year', v.yearPreview, (req) => ledger.previewYearEnd(req.emr, req.params.year));
r('post', '/year-end/:year/close', v.yearClose, (req) => ledger.closeYear(req.emr, req.params.year));
r('post', '/recurring', v.recurring, (req) => ledger.addRecurring(req.emr, req.body), 201);
versioned('patch', '/recurring/:id', v.updateRecurring, (req, version) => ledger.updateRecurring(req.emr, req.params.id, version, req.body));
r('post', '/recurring/run', v.run, (req) => ledger.runRecurring(req.emr, req.body));
