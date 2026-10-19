// /api/v1/emr/organizations/:organizationId/transfers (patient transfers of care)
// Mounted under the EMR tenant router, so auth, tenant, entitlement and rate limit already ran.
//
// Who can do what (migration 20261103090000_emr_transfers):
//   doctor, nurse, front desk: see, record, complete and cancel transfers
//   hospital admin:            see
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send, sendResult } from '../core/http.js';
import { readIdempotencyKey } from '../core/idempotency.js';
import * as transfers from './transfers.service.js';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const v = {
  list: z.object({
    params: z.object(org).strict(),
    query: z.object({ direction: z.enum(['IN', 'OUT']).optional(), status: z.enum(['PENDING', 'COMPLETED', 'CANCELLED']).optional(), limit: z.coerce.number().int().min(1).max(500).default(300) }).strict(),
  }),
  create: z.object({
    params: z.object(org).strict(),
    query: noQuery,
    body: z.object({
      direction: z.enum(['IN', 'OUT']), patientId: z.uuid().optional(), patientName: text(160).optional(), facility: text(200),
      reason: z.enum(transfers.TRANSFER_REASONS), summary: text(4000).optional(),
    }).strict()
      .refine((b) => b.direction !== 'OUT' || !!b.patientId, { path: ['patientId'], message: 'Choose the patient being transferred out.' })
      .refine((b) => b.direction !== 'IN' || (!!b.patientName && !b.patientId), { path: ['patientName'], message: 'Give the name of the person received.' }),
  }),
  finish: z.object({ params: z.object({ ...org, transferId: z.uuid() }).strict(), query: noQuery, body: z.object({}).strict() }),
};

export const transferRoutes = express.Router({ mergeParams: true });
transferRoutes.get('/', check(v.list), allow('transfer.read'),
  handle(async (req, res) => res.json({ status: 'success', data: await transfers.listTransfers(req.emr, req.query) })));
transferRoutes.post('/', check(v.create), allow('transfer.manage'),
  handle(async (req, res) => sendResult(res, await transfers.createTransfer(req.emr, req.body, { idempotencyKey: readIdempotencyKey(req) }))));
for (const action of ['complete', 'cancel']) {
  transferRoutes.post(`/:transferId/${action}`, check(v.finish), allow('transfer.manage'),
    handle(async (req, res) => send(res, await transfers.finishTransfer(req.emr, req.params.transferId, requireVersion(req), action))));
}
