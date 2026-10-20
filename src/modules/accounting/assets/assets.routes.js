// /api/v1/accounting/organizations/:organizationId/{fixed-assets,planning}
// Fixed assets: read with acct.view, everything else with acct.post. Planning — cost centres, budgets and
// tax returns: read with acct.view, prepared with acct.post; activating a budget takes acct.approve. Tax
// filing is recorded with the authority's own acknowledgement. The services check each action.
import express from 'express';
import { z } from 'zod';
import { handle, validateEmr as check } from '../../emr/core/validate.js';
import { requireVersion } from '../../emr/core/concurrency.js';
import { send } from '../../emr/core/http.js';
import * as fa from './assets.service.js';
import * as plan from '../planning/planning.service.js';

const org = { organizationId: z.uuid() };
const withId = { ...org, id: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const free = (max) => z.string().trim().max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])*$/u, 'Contains control characters');
const when = z.iso.datetime({ offset: true }).or(z.iso.date());
const money = z.number().min(0).max(1e13);
const accountNumber = z.number().int().min(1000).max(9999);
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const method = z.enum(['Straight Line', 'Reducing Balance']);
const body = (shape, params = org) => z.object({ params: z.object(params).strict(), query: noQuery, body: z.object(shape).strict() });
const changes = (shape, params = withId) => z.object({
  params: z.object(params).strict(), query: noQuery,
  body: z.object(shape).strict().refine((b) => Object.values(b).some((x) => x !== undefined), 'Send at least one field to change'),
});
const depreciation = { method, usefulLifeMonths: z.number().int().min(1).max(1200), salvageValue: money, reducingRateAnnual: z.number().positive().max(100).optional() };

const v = {
  overview: z.object({ params: z.object(org).strict(), query: noQuery }),
  asset: body({ id: z.uuid().optional(), name: text(160), category: text(80), acquisitionDate: when, cost: z.number().positive().max(1e13), assetAccountNumber: accountNumber, ...depreciation, fundedFromAccount: accountNumber.optional(), sourceBillId: z.uuid().optional() }),
  construction: body({ id: z.uuid().optional(), name: text(160), category: text(80), assetAccountNumber: accountNumber, startDate: when }),
  cwipCost: body({ amount: z.number().positive().max(1e13), date: when, description: text(300), fromAccount: accountNumber }, withId),
  capitalise: body({ date: when, ...depreciation }, withId),
  run: body({ period }),
  catchUp: body({ through: period.optional() }),
  revalue: body({ newCarryingValue: money, date: when, note: free(500).optional() }, withId),
  dispose: body({ date: when, proceeds: money, proceedsAccount: accountNumber }, withId),
  empty: body({}, withId),
  centre: body({ id: z.uuid().optional(), code: z.string().trim().regex(/^[A-Za-z0-9-]{1,20}$/), name: text(120) }),
  updateCentre: changes({ name: text(120).optional(), active: z.boolean().optional() }),
  budget: body({ id: z.uuid().optional(), name: text(160), fiscalYear: z.number().int().min(2000).max(2100), copyFromId: z.uuid().optional(), adjustPct: z.number().min(-100).max(1000).optional() }),
  budgetStatus: body({ status: z.enum(['Draft', 'Active', 'Closed']) }, withId),
  line: body({ id: z.string().max(60).optional(), accountNumber, costCentreId: z.uuid().optional(), monthly: z.array(z.number().min(-1e13).max(1e13)).length(12) }, withId),
  removeLine: body({}, { ...withId, lineId: z.string().max(60) }),
  taxReturn: body({ id: z.uuid().optional(), returnType: z.enum(['VAT', 'WHT', 'PAYE']), periodStart: when, periodEnd: when }),
  filing: body({ submissionRef: text(100), filedVia: free(120).optional() }, withId),
  pay: body({ fromAccount: accountNumber }, withId),
};

const r = (router, method, path, schema, fn, status = 200) => router[method](path, check(schema), handle(async (req, res) => send(res, await fn(req), status)));

export const assetRoutes = express.Router({ mergeParams: true });
r(assetRoutes, 'get', '/', v.overview, (req) => fa.overview(req.emr));
r(assetRoutes, 'post', '/', v.asset, (req) => fa.addAsset(req.emr, req.body), 201);
r(assetRoutes, 'post', '/construction', v.construction, (req) => fa.startConstruction(req.emr, req.body), 201);
r(assetRoutes, 'post', '/depreciation/run', v.run, (req) => fa.runDepreciation(req.emr, req.body), 201);
r(assetRoutes, 'post', '/depreciation/catch-up', v.catchUp, (req) => fa.catchUp(req.emr, req.body));
r(assetRoutes, 'post', '/:id/construction-costs', v.cwipCost, (req) => fa.addCwipCost(req.emr, req.params.id, req.body));
r(assetRoutes, 'post', '/:id/capitalise', v.capitalise, (req) => fa.capitaliseCwip(req.emr, req.params.id, req.body));
r(assetRoutes, 'post', '/:id/revalue', v.revalue, (req) => fa.revalueAsset(req.emr, req.params.id, req.body));
r(assetRoutes, 'post', '/:id/dispose', v.dispose, (req) => fa.disposeAsset(req.emr, req.params.id, req.body));
r(assetRoutes, 'post', '/:id/retire', v.empty, (req) => fa.retireAsset(req.emr, req.params.id));

export const planningRoutes = express.Router({ mergeParams: true });
r(planningRoutes, 'get', '/', v.overview, (req) => plan.overview(req.emr));
r(planningRoutes, 'post', '/cost-centres', v.centre, (req) => plan.addCostCentre(req.emr, req.body), 201);
planningRoutes.patch('/cost-centres/:id', check(v.updateCentre), handle(async (req, res) => send(res, await plan.updateCostCentre(req.emr, req.params.id, requireVersion(req), req.body))));
r(planningRoutes, 'post', '/budgets', v.budget, (req) => plan.createBudget(req.emr, req.body), 201);
r(planningRoutes, 'post', '/budgets/:id/status', v.budgetStatus, (req) => plan.setBudgetStatus(req.emr, req.params.id, req.body));
r(planningRoutes, 'post', '/budgets/:id/lines', v.line, (req) => plan.upsertLine(req.emr, req.params.id, req.body));
r(planningRoutes, 'post', '/budgets/:id/lines/:lineId/remove', v.removeLine, (req) => plan.removeLine(req.emr, req.params.id, req.params.lineId));
r(planningRoutes, 'post', '/tax-returns', v.taxReturn, (req) => plan.prepareReturn(req.emr, req.body), 201);
r(planningRoutes, 'post', '/tax-returns/:id/filing', v.filing, (req) => plan.recordFiling(req.emr, req.params.id, req.body));
r(planningRoutes, 'post', '/tax-returns/:id/pay', v.pay, (req) => plan.payReturn(req.emr, req.params.id, req.body));
