// /api/v1/emr/organizations/:organizationId/immunizations
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (migration 20261028090000_emr_immunizations):
//   doctor, nurse:  see doses, defaulters and AEFI; give doses; report AEFI; mark a dose entered-in-error
//   hospital admin: see
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { send, sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import { VACCINE_CODES } from './immunizations.policy.js';
import * as immunizations from './immunizations.service.js';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');
const v = {
  list: z.object({
    params: z.object(org).strict(),
    query: z.object({ patientId: z.uuid().optional(), aefi: z.enum(['true']).optional(), from: z.iso.date().optional(), to: z.iso.date().optional(), limit: z.coerce.number().int().min(1).max(2000).default(200) }).strict(),
  }),
  defaulters: z.object({ params: z.object(org).strict(), query: noQuery }),
  give: z.object({
    params: z.object(org).strict(),
    query: noQuery,
    body: z.object({ patientId: z.uuid(), vaccineCode: z.enum(VACCINE_CODES), batchNumber: text(60), site: text(60), givenAt: z.iso.datetime({ offset: true }).optional() }).strict(),
  }),
  aefi: z.object({
    params: z.object({ ...org, immunizationId: z.uuid() }).strict(),
    query: noQuery,
    body: z.object({ symptoms: text(500), severity: z.enum(['SERIOUS', 'NON_SERIOUS']), onsetHours: z.number().int().min(0).max(720), actionTaken: text(500) }).strict(),
  }),
  error: z.object({
    params: z.object({ ...org, immunizationId: z.uuid() }).strict(),
    query: noQuery,
    body: z.object({ reason: z.string().trim().min(3).max(300).regex(/^[^\p{Cc}]+$/u, 'Contains control characters') }).strict(),
  }),
};

export const immunizationRoutes = express.Router({ mergeParams: true });
immunizationRoutes.get('/', check(v.list), allow('immunization.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await immunizations.listDoses(req.emr, { patientId: req.query.patientId, aefiOnly: req.query.aefi === 'true', from: req.query.from, to: req.query.to, limit: req.query.limit }) })));
immunizationRoutes.get('/defaulters', check(v.defaulters), allow('immunization.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await immunizations.defaulters(req.emr) })));
immunizationRoutes.post('/', check(v.give), allow('immunization.give'),
  handle(async (req, res) => sendResult(res, await immunizations.giveDose(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
immunizationRoutes.post('/:immunizationId/aefi', check(v.aefi), allow('immunization.give'),
  handle(async (req, res) => send(res, await immunizations.reportAefi(req.emr, req.params.immunizationId, req.body), 201)));
immunizationRoutes.post('/:immunizationId/entered-in-error', check(v.error), allow('immunization.give'),
  handle(async (req, res) => send(res, await immunizations.markDoseEnteredInError(req.emr, req.params.immunizationId, req.body))));
