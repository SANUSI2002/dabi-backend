// /api/v1/accounting/organizations/:organizationId/attachments — files on bills and invoices. The file
// itself is the request body (application/pdf, image/jpeg or image/png), with its name in
// X-Document-Filename and an Idempotency-Key; what it belongs to goes in the query. acct.view lists and
// opens; acct.post attaches and removes (the service checks).
import express from 'express';
import { z } from 'zod';
import { handle, validateEmr as check } from '../../emr/core/validate.js';
import { send } from '../../emr/core/http.js';
import { EmrError } from '../../emr/core/errors.js';
import * as attachments from './attachments.service.js';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const filename = z.string().trim().min(1).max(200).regex(/^[^\p{Cc}/\\]+$/u, 'Choose a file with a valid name');
const v = {
  list: z.object({ params: z.object(org).strict(), query: noQuery }),
  receive: z.object({
    params: z.object(org).strict(),
    query: z.object({ entityType: z.enum(['invoice', 'bill']), entityId: z.uuid(), entityLabel: z.string().trim().min(1).max(120), note: z.string().trim().min(1).max(300).optional() }).strict(),
  }),
  one: z.object({ params: z.object({ ...org, id: z.uuid() }).strict(), query: noQuery }),
};

export const attachmentRoutes = express.Router({ mergeParams: true });
attachmentRoutes.get('/', check(v.list), handle(async (req, res) => send(res, await attachments.listAttachments(req.emr))));
attachmentRoutes.post('/receive', check(v.receive), express.raw({ type: Object.keys(attachments.EXTENSIONS), limit: 10 * 1024 * 1024 }), handle(async (req, res) => {
  let name;
  try { name = filename.parse(decodeURIComponent(req.get('X-Document-Filename') || '')); } catch { throw new EmrError('VALIDATION_FAILED', { message: 'Choose a file with a valid name.' }); }
  const contentType = req.get('content-type')?.split(';')[0].trim();
  return send(res, await attachments.receiveAttachment(req.emr, { ...req.query, filename: name }, req.body, contentType, req.get('Idempotency-Key')), 202);
}));
attachmentRoutes.post('/:id/download', check(v.one), handle(async (req, res) => send(res, await attachments.downloadAttachment(req.emr, req.params.id))));
attachmentRoutes.post('/:id/remove', check(v.one), handle(async (req, res) => send(res, await attachments.removeAttachment(req.emr, req.params.id))));
