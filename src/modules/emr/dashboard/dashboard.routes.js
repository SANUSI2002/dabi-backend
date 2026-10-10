// /api/v1/emr/organizations/:organizationId/dashboard — the workspace home screen.
// Open to anyone with one of the screens it summarises; each part checks its own permission.
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { send } from '../core/http.js';
import { dashboard } from './dashboard.service.js';

const DAY = 86_400_000;
/** A recent instant: the caller's start of day (within ~a day) or of month (within ~a month). */
const recent = (maxAgeMs) => z.iso.datetime({ offset: true }).refine((value) => {
  const at = new Date(value).getTime();
  return at <= Date.now() + DAY && at >= Date.now() - maxAgeMs;
}, 'Out of range');

const query = z.object({
  params: z.object({ organizationId: z.uuid() }).strict(),
  query: z.object({ since: recent(2 * DAY), monthStart: recent(33 * DAY) }).strict(),
});

export const dashboardRoutes = express.Router({ mergeParams: true });
dashboardRoutes.get('/', check(query),
  allow('queue.read', 'patient.read', 'lab.order.read', 'prescription.read', 'emr.stock.view', 'billing.read', 'admission.read'),
  handle(async (req, res) => send(res, await dashboard(req.emr, req.query))));
