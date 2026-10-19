// /api/v1/emr/organizations/:organizationId/programmes (NCD register, malaria indicators)
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (migration 20261101090000_emr_programmes):
//   doctor, nurse:  see the NCD register and malaria indicators; enrol NCD clients
//   hospital admin: see
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as programmes from './programmes.service.js';

const org = { organizationId: z.uuid() };
const v = {
  ncdList: z.object({
    params: z.object(org).strict(),
    query: z.object({ dueWithinDays: z.coerce.number().int().min(0).max(90).optional(), limit: z.coerce.number().int().min(1).max(1000).default(500) }).strict(),
  }),
  ncdEnrol: z.object({
    params: z.object(org).strict(),
    query: z.object({}).strict(),
    body: z.object({
      patientId: z.uuid(), condition: z.enum(programmes.NCD_CONDITIONS),
      systolic: z.number().int().min(50).max(260).optional(), diastolic: z.number().int().min(30).max(180).optional(),
      fastingGlucoseMmol: z.number().min(1).max(40).multipleOf(0.1).optional(), control: z.enum(['CONTROLLED', 'UNCONTROLLED']), nextVisitDate: z.iso.date(),
    }).strict()
      .refine((b) => (b.systolic === undefined) === (b.diastolic === undefined), { path: ['diastolic'], message: 'Give both systolic and diastolic pressure.' })
      .refine((b) => b.systolic === undefined || b.diastolic < b.systolic, { path: ['diastolic'], message: 'Diastolic must be lower than systolic.' }),
  }),
  malaria: z.object({ params: z.object(org).strict(), query: z.object({ since: z.iso.date().optional() }).strict() }),
};

export const programmeRoutes = express.Router({ mergeParams: true });
programmeRoutes.get('/ncd', check(v.ncdList), allow('programme.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await programmes.listNcd(req.emr, req.query) })));
programmeRoutes.post('/ncd', check(v.ncdEnrol), allow('ncd.enrol'),
  handle(async (req, res) => sendResult(res, await programmes.enrolNcd(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
programmeRoutes.get('/malaria', check(v.malaria), allow('programme.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await programmes.malariaIndicators(req.emr, req.query) })));
