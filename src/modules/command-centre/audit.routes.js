// /api/v1/command-centre/audit, /search and /me.
//
// audit  — the platform-wide, append-only audit trail (who, when, what, target, reason, before/after),
//          filterable, with a CSV export that is itself audited and needs recent two-step verification.
// search — one box across patients, orders, pharmacies, doctors, organisations and cases, returning
//          only the groups the caller's permissions allow (patients masked).
// me     — the caller's platform roles and permissions, so the Command Centre shows only what they can use.
import express from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { requireRecentMfa } from '../../middleware/mfaMiddleware.js';
import { maskIp } from '../audit/audit.context.js';
import { AUDIT_CATEGORIES } from '../audit/audit.service.js';
import { adminAudit, allow, can, ccError, handle, maskEmail, namesFor, pageQuery, paged, rangeQuery, rangeWhere, reason } from './cc.common.js';

export const auditRoutes = express.Router();
export const searchRoutes = express.Router();
export const meRoutes = express.Router();

const none = z.object({}).strict();
const uuid = z.string().uuid();

const filters = {
  category: z.enum(AUDIT_CATEGORIES).optional(),
  action: z.string().regex(/^[A-Z_]{3,64}$/).optional(),
  actorUserId: uuid.optional(),
  subjectUserId: uuid.optional(),
  resourceType: z.string().regex(/^[a-z_:-]{2,64}$/).optional(),
  resourceId: z.string().max(64).optional(),
  ...rangeQuery,
};
const whereFor = (f) => ({
  ...rangeWhere(f),
  ...(f.category ? { category: f.category } : {}), ...(f.action ? { action: f.action } : {}),
  ...(f.actorUserId ? { actorUserId: f.actorUserId } : {}), ...(f.subjectUserId ? { subjectUserId: f.subjectUserId } : {}),
  ...(f.resourceType ? { resourceType: f.resourceType } : {}), ...(f.resourceId ? { resourceId: f.resourceId } : {}),
});
const view = (r, names) => ({
  id: r.id, at: r.createdAt, category: r.category, action: r.action,
  summary: /^You /.test(r.summary) ? `${names.get(r.actorUserId) ?? 'Someone'} ${r.summary.slice(4)}` : r.summary,
  actor: names.get(r.actorUserId) ?? 'Unknown', actorUserId: r.actorUserId,
  subject: r.subjectUserId ? names.get(r.subjectUserId) ?? 'Unknown' : null, subjectUserId: r.subjectUserId,
  resourceType: r.resourceType, resourceId: r.resourceId,
  reason: r.context?.reason ?? null, roles: r.context?.roles ?? null, before: r.context?.before ?? null, after: r.context?.after ?? null,
  device: r.device, ip: maskIp(r.ipAddress), location: r.city || r.country ? [r.city, r.region, r.country].filter(Boolean).join(', ') : null,
});

auditRoutes.get('/', allow('platform.audit.read'),
  validate(z.object({ query: z.object({ ...filters, ...pageQuery }).strict(), params: none }).passthrough()),
  handle(async (req) => {
    const { page, limit } = req.query;
    const where = whereFor(req.query);
    const [rows, total] = await Promise.all([
      prisma.auditEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
      prisma.auditEvent.count({ where }),
    ]);
    const names = await namesFor(prisma, rows.flatMap((r) => [r.actorUserId, r.subjectUserId]));
    return { ...paged(rows.map((r) => view(r, names)), total, { page, limit }), appendOnly: true };
  }));

const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Neutralise spreadsheet formulas and quote every cell.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
};
const EXPORT_LIMIT = 5000;

auditRoutes.post('/export', allow('platform.audit.read'), requireRecentMfa,
  validate(z.object({ body: z.object({ reason, filters: z.object(filters).strict().default({}) }).strict(), query: none, params: none })),
  handle(async (req, res) => {
    const where = whereFor(req.body.filters);
    const total = await prisma.auditEvent.count({ where });
    if (total > EXPORT_LIMIT) throw ccError('EXPORT_TOO_LARGE', 400, `That matches ${total} entries; narrow the filters to at most ${EXPORT_LIMIT}.`, { total, limit: EXPORT_LIMIT });
    const rows = await prisma.auditEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const names = await namesFor(prisma, rows.flatMap((r) => [r.actorUserId, r.subjectUserId]));
    await adminAudit(prisma, req, { action: 'ADMIN_EXPORT', summary: `Exported ${rows.length} audit entries`, resourceType: 'audit_export', reason: req.body.reason, after: { filters: req.body.filters, rows: rows.length } });
    const header = ['time', 'category', 'action', 'summary', 'actor', 'actor_id', 'subject', 'subject_id', 'resource_type', 'resource_id', 'reason', 'before', 'after', 'device', 'ip_masked', 'location'];
    const lines = rows.map((r) => view(r, names)).map((v) => [v.at.toISOString(), v.category, v.action, v.summary, v.actor, v.actorUserId, v.subject, v.subjectUserId, v.resourceType, v.resourceId, v.reason, v.before, v.after, v.device, v.ip, v.location].map(csvCell).join(','));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="sabi-audit-${new Date().toISOString().slice(0, 19).replaceAll(':', '')}.csv"`);
    res.send([header.join(','), ...lines].join('\r\n'));
  }));

// ------------------------------------------------------------------------------------------------
// Global search
// ------------------------------------------------------------------------------------------------
searchRoutes.get('/', allow('platform.ops.read', 'platform.patients.read', 'platform.finance.read', 'platform.support.manage'),
  validate(z.object({ query: z.object({ q: z.string().trim().min(2).max(80) }).strict(), params: none }).passthrough()),
  handle(async (req) => {
    const q = req.query.q;
    const like = { contains: q, mode: 'insensitive' };
    const ops = can(req, 'platform.ops.read');
    const groups = await Promise.all([
      can(req, 'platform.patients.read') ? prisma.user.findMany({ where: { roles: { some: { role: 'PATIENT' } }, OR: [{ full_name: like }, { email: like }, { patientId: like }, ...(q.replace(/\D/g, '').length >= 4 ? [{ phone_number: { contains: q.replace(/[^\d+]/g, '') } }] : [])] }, take: 6, select: { id: true, patientId: true, full_name: true, email: true, accountStatus: true } })
        .then((rows) => ({ type: 'patient', label: 'Patients', items: rows.map((u) => ({ id: u.id, title: u.full_name || u.patientId, subtitle: `${u.patientId} · ${maskEmail(u.email) ?? 'no email'} · ${u.accountStatus.toLowerCase()}` })) })) : null,
      ops || can(req, 'platform.finance.read') ? prisma.order.findMany({ where: { OR: [{ reference: like }, { paymentAttempts: { some: { providerReference: q } } }] }, take: 6, orderBy: { createdAt: 'desc' }, select: { id: true, reference: true, status: true, totalPayableMinor: true, createdAt: true } })
        .then((rows) => ({ type: 'order', label: 'Orders', items: rows.map((o) => ({ id: o.id, title: o.reference, subtitle: `${o.status.replaceAll('_', ' ').toLowerCase()} · ₦${(o.totalPayableMinor / 100).toLocaleString('en-NG')}` })) })) : null,
      ops ? prisma.pharmacy.findMany({ where: { OR: [{ name: like }, { city: like }] }, take: 6, select: { id: true, name: true, city: true, complianceStatus: true } })
        .then((rows) => ({ type: 'pharmacy', label: 'Pharmacies', items: rows.map((p) => ({ id: p.id, title: p.name, subtitle: `${p.city} · ${p.complianceStatus.toLowerCase()}` })) })) : null,
      ops ? prisma.professionalProfile.findMany({ where: { OR: [{ user: { full_name: like } }, { registrationNumber: like }, { specialty: like }] }, take: 6, select: { id: true, specialty: true, verificationStatus: true, user: { select: { full_name: true } } } })
        .then((rows) => ({ type: 'doctor', label: 'Doctors', items: rows.map((d) => ({ id: d.id, title: d.user.full_name ?? 'Unnamed', subtitle: `${d.specialty ?? 'General'} · ${d.verificationStatus.toLowerCase()}` })) })) : null,
      ops ? prisma.organisation.findMany({ where: { OR: [{ name: like }, { city: like }] }, take: 6, select: { id: true, name: true, type: true, status: true, city: true } })
        .then((rows) => ({ type: 'organization', label: 'Organisations', items: rows.map((o) => ({ id: o.id, title: o.name, subtitle: `${o.type.replaceAll('_', ' ').toLowerCase()} · ${o.city} · ${o.status.toLowerCase()}` })) })) : null,
      ops || can(req, 'platform.support.manage') ? prisma.opsCase.findMany({ where: { OR: [{ reference: like }, { title: like }] }, take: 6, orderBy: { createdAt: 'desc' }, select: { id: true, reference: true, title: true, status: true, kind: true } })
        .then((rows) => ({ type: 'case', label: 'Cases & incidents', items: rows.map((c) => ({ id: c.id, title: `${c.reference} · ${c.title}`, subtitle: `${c.kind.toLowerCase()} · ${c.status.replaceAll('_', ' ').toLowerCase()}` })) })) : null,
    ]);
    return { q, groups: groups.filter((g) => g && g.items.length) };
  }));

// ------------------------------------------------------------------------------------------------
// Me
// ------------------------------------------------------------------------------------------------
meRoutes.get('/', validate(z.object({ query: none, params: none }).passthrough()),
  handle(async (req) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, full_name: true, email: true, mfaTotp: { select: { enabledAt: true } } } });
    return {
      id: user.id, name: user.full_name, email: user.email, twoStepVerification: Boolean(user.mfaTotp?.enabledAt),
      roles: req.accessContext?.roles ?? [], permissions: req.accessContext?.permissions ?? [],
    };
  }));

