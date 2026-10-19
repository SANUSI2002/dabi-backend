// /api/v1/emr/organizations/:organizationId/nutrition (growth monitoring and CMAM)
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (migration 20261031090000_emr_nutrition):
//   doctor, nurse:  see, record growth visits and CMAM screenings, discharge, mark a growth visit in error
//   hospital admin: see
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send, sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as nutrition from './nutrition.service.js';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const muac = z.number().min(5).max(25).multipleOf(0.1);
const listQuery = { patientId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) };
const v = {
  growthList: z.object({ params: z.object(org).strict(), query: z.object(listQuery).strict() }),
  cmamList: z.object({ params: z.object(org).strict(), query: z.object({ ...listQuery, open: z.enum(['true']).optional() }).strict() }),
  growth: z.object({
    params: z.object(org).strict(),
    query: noQuery,
    body: z.object({
      patientId: z.uuid(), visitDate: z.iso.date(), weightKg: z.number().min(0.5).max(40).multipleOf(0.1), heightCm: z.number().min(30).max(130).multipleOf(0.1),
      muacCm: muac, waz: z.number().min(-6).max(6).multipleOf(0.1).optional(),
      feeding: z.enum(['EXCLUSIVE_BREASTFEEDING', 'COMPLEMENTARY_AND_BREAST', 'FAMILY_DIET', 'FORMULA']),
    }).strict(),
  }),
  screening: z.object({
    params: z.object(org).strict(),
    query: noQuery,
    body: z.object({
      patientId: z.uuid(), screeningDate: z.iso.date(), muacCm: muac, oedema: z.enum(['NONE', 'MILD', 'MODERATE', 'SEVERE']), appetite: z.enum(['PASS', 'FAIL']),
      growthMonitoringDone: z.boolean().optional(), notes: z.string().trim().min(1).max(1000).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters').optional(),
    }).strict(),
  }),
  discharge: z.object({
    params: z.object({ ...org, screeningId: z.uuid() }).strict(),
    query: noQuery,
    body: z.object({ outcome: z.enum(['CURED', 'NON_RESPONSE', 'DEFAULTER', 'DEATH', 'TRANSFERRED']) }).strict(),
  }),
  growthError: z.object({
    params: z.object({ ...org, visitId: z.uuid() }).strict(),
    query: noQuery,
    body: z.object({ reason: z.string().trim().min(3).max(300).regex(/^[^\p{Cc}]+$/u, 'Contains control characters') }).strict(),
  }),
};

export const nutritionRoutes = express.Router({ mergeParams: true });
nutritionRoutes.get('/growth', check(v.growthList), allow('nutrition.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await nutrition.listGrowthVisits(req.emr, req.query) })));
nutritionRoutes.post('/growth', check(v.growth), allow('nutrition.record'),
  handle(async (req, res) => sendResult(res, await nutrition.recordGrowthVisit(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
nutritionRoutes.post('/growth/:visitId/entered-in-error', check(v.growthError), allow('nutrition.record'),
  handle(async (req, res) => send(res, await nutrition.markGrowthEnteredInError(req.emr, req.params.visitId, req.body))));
nutritionRoutes.get('/cmam', check(v.cmamList), allow('nutrition.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await nutrition.listScreenings(req.emr, { ...req.query, open: req.query.open === 'true' }) })));
nutritionRoutes.post('/cmam', check(v.screening), allow('nutrition.record'),
  handle(async (req, res) => sendResult(res, await nutrition.recordScreening(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
nutritionRoutes.post('/cmam/:screeningId/discharge', check(v.discharge), allow('nutrition.record'),
  handle(async (req, res) => send(res, await nutrition.discharge(req.emr, req.params.screeningId, requireVersion(req), req.body))));
