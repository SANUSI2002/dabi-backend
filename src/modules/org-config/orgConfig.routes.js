// Organization configuration API: /api/v1/org-config/organizations/:organizationId — master-data lists,
// terminology, letter templates and generated letters, shared by every Sabi product the organization has.
//
// Same chain and tenancy as the product APIs, gated by holding any of them (EMR or Workforce):
//   requestContext → protect → org param → requireOrganization → orgConfigTenant → tenantRateLimit.
// Who can do what (migration 20261117090000_platform_config; the service checks each list's product):
//   every member:                         read lists and terminology
//   Workforce lists, letters:             hr.manage   ·  EMR lists: catalog.manage
//   platform-wide lists, terminology:     platform.config (hospital admin, owner)
//   module switches (within the package): platform.config; every member reads them
import express from 'express';
import { z } from 'zod';
import { protect } from '../../middleware/authMiddleware.js';
import { requireOrganization } from '../../middleware/accessMiddleware.js';
import { requestContext } from '../emr/core/logging.js';
import { orgConfigTenant } from '../emr/core/context.js';
import { tenantRateLimit } from '../emr/core/rateLimit.js';
import { EmrError, emrErrorHandler } from '../emr/core/errors.js';
import { handle, validateEmr as check } from '../emr/core/validate.js';
import { requireVersion } from '../emr/core/concurrency.js';
import { send } from '../emr/core/http.js';
import * as config from './orgConfig.service.js';
import { moduleOverview, saveModules } from './modules.service.js';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const category = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
const body = (shape, params = org) => z.object({ params: z.object(params).strict(), query: noQuery, body: z.object(shape).strict() });
const meta = z.record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()])).refine((m) => Object.keys(m).length <= 20, 'At most 20 fields');
const term = z.object({ singular: z.string().trim().max(80).optional(), plural: z.string().trim().max(80).optional() }).strict();
const letterCategory = text(120); // a Letter Categories item (checked by the service)

const v = {
  overview: z.object({ params: z.object(org).strict(), query: noQuery }),
  addItem: body({ id: z.uuid().optional(), label: text(120), code: z.string().trim().max(40).optional(), meta: meta.optional() }, { ...org, category }),
  updateItem: z.object({
    params: z.object({ ...org, category, id: z.uuid() }).strict(), query: noQuery,
    body: z.object({ label: text(120).optional(), code: z.string().trim().max(40).optional(), meta: meta.optional(), active: z.boolean().optional() }).strict()
      .refine((b) => Object.values(b).some((x) => x !== undefined), 'Send at least one field to change'),
  }),
  removeItem: body({}, { ...org, category, id: z.uuid() }),
  terms: body({ overrides: z.object(Object.fromEntries(config.TERM_KEYS.map((k) => [k, term.optional()]))).strict() }),
  addTemplate: body({ key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,59}$/), name: text(160), category: letterCategory, body: text(20000), signatories: z.array(text(160)).max(6) }),
  saveTemplate: z.object({
    params: z.object({ ...org, key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,59}$/) }).strict(), query: noQuery,
    body: z.object({ name: text(160).optional(), category: letterCategory.optional(), body: text(20000).optional(), signatories: z.array(text(160)).max(6).optional(), active: z.boolean().optional() }).strict()
      .refine((b) => Object.values(b).some((x) => x !== undefined), 'Send at least one field to change'),
  }),
  letter: body({
    id: z.uuid().optional(), templateKey: z.string().max(60), title: text(200).optional(), subjectStaffId: z.uuid().optional(), reference: z.string().trim().max(100).optional(),
    data: z.record(z.string().regex(/^[\w.-]{1,60}$/), z.union([z.string().max(4000), z.number()]).nullable()).refine((d) => Object.keys(d).length <= 60, 'At most 60 fields'),
  }),
  sent: body({ to: text(160) }, { ...org, id: z.uuid() }),
  modules: body({ disabled: z.array(z.string().regex(/^[a-z][a-zA-Z0-9.]{1,79}$/)).max(100) }),
};

const tenant = express.Router({ mergeParams: true });
// Every member reads; the service checks who may change each list, so no route-level permission here.
const r = (method, path, schema, fn, status = 200) => tenant[method](path, check(schema), handle(async (req, res) => send(res, await fn(req), status)));
r('get', '/', v.overview, (req) => config.overview(req.emr));
r('post', '/master-data/:category', v.addItem, (req) => config.addItem(req.emr, req.params.category, req.body), 201);
tenant.patch('/master-data/:category/:id', check(v.updateItem), handle(async (req, res) => send(res, await config.updateItem(req.emr, req.params.category, req.params.id, requireVersion(req), req.body))));
r('post', '/master-data/:category/:id/remove', v.removeItem, (req) => config.removeItem(req.emr, req.params.category, req.params.id));
tenant.put('/terminology', check(v.terms), handle(async (req, res) => send(res, await config.saveTerms(req.emr, requireVersion(req), req.body))));
r('post', '/letter-templates', v.addTemplate, (req) => config.addTemplate(req.emr, req.body), 201);
tenant.patch('/letter-templates/:key', check(v.saveTemplate), handle(async (req, res) => send(res, await config.saveTemplate(req.emr, req.params.key, requireVersion(req), req.body))));
r('post', '/letters', v.letter, (req) => config.generateLetter(req.emr, req.body), 201);
r('post', '/letters/:id/sent', v.sent, (req) => config.markLetterSent(req.emr, req.params.id, req.body));
r('get', '/modules', v.overview, (req) => moduleOverview(req.emr, req.accessContext));
tenant.put('/modules', check(v.modules), handle(async (req, res) => send(res, await saveModules(req.emr, req.accessContext, requireVersion(req), req.body))));

const router = express.Router();
router.use(requestContext);
router.use('/organizations/:organizationId', protect, check(z.object({ params: z.object(org) })), requireOrganization, orgConfigTenant, tenantRateLimit, tenant);
router.use((req, res, next) => next(new EmrError('NOT_FOUND')));
router.use(emrErrorHandler);

export default router;
