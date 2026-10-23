// /api/v1/emr/organizations/:organizationId/catalogs/{diagnoses,categories}
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (migration 20261109090000_emr_catalogs):
//   hospital admin, owner:          manage both catalogs
//   clinicians:                     read the diagnosis list (they pick from it)
//   anyone who reads patients:      read patient categories
// The EPI schedule and the IDSR disease list are national and fixed in this EMR: read-only here.
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send } from '../core/http.js';
import * as catalogs from './catalogs.service.js';
import { VACCINES } from '../immunizations/immunizations.policy.js';
import { DISEASES } from '../surveillance/surveillance.service.js';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');
const fields = {
  diagnoses: {
    create: { code: z.string().trim().toUpperCase().regex(/^[0-9A-Z][0-9A-Z.&/]{1,15}$/, 'Use the ICD-11 code (e.g. 1F40)'), name: text(200), chapter: text(80), ncd: z.boolean().default(false), notifiable: z.boolean().default(false) },
    update: { name: text(200), chapter: text(80), ncd: z.boolean(), notifiable: z.boolean(), active: z.boolean() },
  },
  categories: {
    create: { code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,24}$/, 'Codes are letters, digits, - and _'), name: text(80), exempt: z.boolean().default(false), reason: text(200).optional() },
    update: { name: text(80), exempt: z.boolean(), reason: text(200).nullable(), active: z.boolean() },
  },
};
const READERS = { diagnoses: ['diagnosis.record', 'clinical.read', 'catalog.manage'], categories: ['patient.read', 'catalog.manage'] };

export const catalogRoutes = express.Router({ mergeParams: true });
for (const kind of ['diagnoses', 'categories']) {
  const list = z.object({ params: z.object(org).strict(), query: z.object({ includeInactive: z.enum(['true', 'false']).transform((s) => s === 'true').optional() }).strict() });
  const create = z.object({ params: z.object(org).strict(), query: noQuery, body: z.object(fields[kind].create).strict() });
  const update = z.object({
    params: z.object({ ...org, id: z.uuid() }).strict(), query: noQuery,
    body: z.object(Object.fromEntries(Object.entries(fields[kind].update).map(([k, s]) => [k, s.optional()]))).strict()
      .refine((b) => Object.values(b).some((v) => v !== undefined), 'Send at least one field to change'),
  });
  catalogRoutes.get(`/${kind}`, check(list), allow(...READERS[kind]), handle(async (req, res) => send(res, await catalogs.listCatalog(req.emr, kind, req.query))));
  catalogRoutes.post(`/${kind}`, check(create), allow('catalog.manage'), handle(async (req, res) => send(res, await catalogs.addEntry(req.emr, kind, req.body), 201)));
  catalogRoutes.patch(`/${kind}/:id`, check(update), allow('catalog.manage'), handle(async (req, res) => send(res, await catalogs.updateEntry(req.emr, kind, req.params.id, requireVersion(req), req.body))));
}

const fixed = z.object({ params: z.object(org).strict(), query: noQuery });
catalogRoutes.get('/vaccines', check(fixed), allow('immunization.read', 'catalog.manage'), handle(async (req, res) => send(res, { items: VACCINES, editable: false })));
catalogRoutes.get('/diseases', check(fixed), allow('surveillance.read', 'catalog.manage'), handle(async (req, res) => send(res, { items: DISEASES, editable: false })));
