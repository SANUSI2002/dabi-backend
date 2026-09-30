// /api/v1/emr/organizations/:organizationId/staff?permission=…
// Colleagues who may do something (e.g. clinicians who order tests), for "communicated to" and
// similar pickers. Names and user ids only — never contact details or other memberships.
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { sendItems } from '../core/http.js';
import { activeMembersWithPermission } from '../core/membership.js';

// Only capabilities a picker needs; the query cannot be used to map the organization's roles.
const PICKABLE = ['lab.order.create', 'diagnosis.record', 'prescription.review', 'prescription.dispense', 'medication.administer', 'vitals.record'];

const list = z.object({
  params: z.object({ organizationId: z.uuid() }).strict(),
  query: z.object({ permission: z.enum(PICKABLE) }).strict(),
});

export const staffRoutes = express.Router({ mergeParams: true });
staffRoutes.get('/', check(list), allow('encounter.read', 'lab.order.read', 'queue.read'),
  handle(async (req, res) => sendItems(res, await activeMembersWithPermission(req.emr.organizationId, req.query.permission))));
