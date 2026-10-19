// /api/v1/emr/organizations/:organizationId/audit-events — the tenant's own EMR access trail.
import express from 'express';
import { z } from 'zod';
import { withTenant } from '../core/db.js';
import { listAudit, recordAudit } from '../core/audit.js';
import { requireEmrPermission } from '../core/context.js';
import { handle, validateEmr } from '../core/validate.js';
import { memberRoleMap } from '../core/membership.js';
import { userNameMap } from '../core/people.js';

const router = express.Router({ mergeParams: true });

router.get('/', validateEmr(z.object({
  params: z.object({ organizationId: z.uuid() }).strict(),
  query: z.object({
    resourceType: z.string().regex(/^[a-z_]{2,40}$/).optional(),
    resourceId: z.uuid().optional(),
    action: z.string().regex(/^[a-z_]{2,40}\.[a-z_]{2,60}$/).optional(),
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }).strict(),
})), requireEmrPermission('audit.view'), handle(async (req, res) => {
  const result = await withTenant(req.emr, async (tx) => {
    const page = await listAudit(tx, req.query);
    const names = await userNameMap(tx, page.items.map((e) => e.actorUserId));
    // Reading the audit trail is itself audited.
    await recordAudit(tx, req.emr, { action: 'audit.viewed', resourceType: 'audit_event' });
    return { ...page, items: page.items.map((e) => ({ ...e, actorName: e.actorUserId ? names.get(e.actorUserId) ?? null : null })) };
  });
  // Roles live in identity tables, read outside the tenant transaction.
  const roles = await memberRoleMap(req.emr.organizationId, result.items.map((e) => e.actorUserId));
  res.json({ status: 'success', data: { ...result, items: result.items.map((e) => ({ ...e, actorRoles: e.actorUserId ? roles.get(e.actorUserId) ?? [] : [] })) } });
}));

export default router;
