// /api/v1/emr/organizations/:organizationId/referrals
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (migration 20261102090000_emr_referrals):
//   doctor, nurse:  see, send, and track referrals to their outcome
//   hospital admin: see
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send, sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as referrals from './referrals.service.js';

const org = { organizationId: z.uuid() };
const one = { ...org, referralId: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const step = (body) => z.object({ params: z.object(one).strict(), query: noQuery, body: body.strict() });
const v = {
  list: z.object({
    params: z.object(org).strict(),
    query: z.object({
      direction: z.string().transform((s) => s.split(',')).pipe(z.array(z.enum(['OUT', 'INTERNAL', 'IN'])).min(1)).optional(),
      patientId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(300),
    }).strict(),
  }),
  create: z.object({
    params: z.object(org).strict(),
    query: noQuery,
    body: z.object({
      patientId: z.uuid(), direction: z.enum(['OUT', 'INTERNAL']), destination: text(200), diagnosis: text(300), reason: z.enum(referrals.REFERRAL_REASONS),
      urgency: z.enum(['ROUTINE', 'URGENT', 'EMERGENCY']), clinicalSummary: text(4000).optional(), attachedLabItemIds: z.array(z.uuid()).max(20).optional(),
    }).strict(),
  }),
  accept: step(z.object({ receivingClinician: text(160).optional() })),
  decline: step(z.object({ reason: text(500) })),
  schedule: step(z.object({ appointmentDate: z.iso.date() })),
  empty: step(z.object({})),
  outcome: step(z.object({ outcome: z.enum(referrals.REFERRAL_OUTCOMES), note: text(2000), by: text(160), backReferral: z.boolean().default(false) })),
};

export const referralRoutes = express.Router({ mergeParams: true });
referralRoutes.get('/', check(v.list), allow('referral.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await referrals.listReferrals(req.emr, req.query) })));
referralRoutes.post('/', check(v.create), allow('referral.manage'),
  handle(async (req, res) => sendResult(res, await referrals.createReferral(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
for (const [action, schema] of [['accept', v.accept], ['decline', v.decline], ['schedule', v.schedule], ['attend', v.empty], ['cancel', v.empty], ['outcome', v.outcome]]) {
  referralRoutes.post(`/:referralId/${action}`, check(schema), allow('referral.manage'),
    handle(async (req, res) => send(res, await referrals.advanceReferral(req.emr, req.params.referralId, requireVersion(req), action, req.body))));
}
