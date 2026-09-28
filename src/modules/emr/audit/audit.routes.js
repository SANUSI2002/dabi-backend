// /api/v1/emr/organizations/:organizationId/audit-events — the tenant's own EMR access trail.
import express from 'express';
import { z } from 'zod';
import { withTenant } from '../core/db.js';
import { listAudit, recordAudit } from '../core/audit.js';
import { requireEmrPermission } from '../core/context.js';
import { handle, validateEmr } from '../core/validate.js';

const router = express.Router({ mergeParams: true });

router.get('/', validateEmr(z.object({
  params: z.object({ organizationId: z.uuid() }).strict(),
  query: z.object({
    resourceType: z.string().regex(/^[a-z_]{2,40}$/).optional(),
    resourceId: z.uuid().optional(),
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }).strict(),
})), requireEmrPermission('audit.view'), handle(async (req, res) => {
  const result = await withTenant(req.emr, async (tx) => {
    const page = await listAudit(tx, req.query);
    // Reading the audit trail is itself audited.
    await recordAudit(tx, req.emr, { action: 'audit.viewed', resourceType: 'audit_event' });
    return page;
  });
  res.json({ status: 'success', data: result });
}));

export default router;
