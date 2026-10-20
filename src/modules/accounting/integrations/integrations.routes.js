// /api/v1/accounting/organizations/:organizationId/integrations
// What the EMR billing, payroll and pharmacy connectors still have to post (acct.view), and running them
// (acct.post). Each source record is posted once, so a sync can be repeated safely.
import express from 'express';
import { z } from 'zod';
import { handle, validateEmr as check } from '../../emr/core/validate.js';
import { send } from '../../emr/core/http.js';
import * as integrations from './integrations.service.js';

const org = { organizationId: z.uuid() };
const MODULES = ['EMR Billing', 'Payroll', 'Pharmacy'];
const v = {
  status: z.object({ params: z.object(org).strict(), query: z.object({}).strict() }),
  sync: z.object({ params: z.object(org).strict(), query: z.object({}).strict(), body: z.object({ modules: z.array(z.enum(MODULES)).min(1).max(3).default(MODULES) }).strict() }),
};

export const integrationRoutes = express.Router({ mergeParams: true });
integrationRoutes.get('/', check(v.status), handle(async (req, res) => send(res, await integrations.status(req.emr))));
integrationRoutes.post('/sync', check(v.sync), handle(async (req, res) => send(res, await integrations.sync(req.emr, req.body))));
