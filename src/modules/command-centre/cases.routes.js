// /api/v1/command-centre/cases — support cases and incidents in one queue. Each case can link a
// patient, order, pharmacy or doctor; every note, status, priority and assignment change is an
// append-only event. Resolving or closing needs a written resolution. Response targets (SLA) are set
// from priority at creation.
import { randomBytes } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { platformAccessFor } from '../identity/identity.service.js';
import { adminAudit, allow, ccError, handle, namesFor, pageQuery, paged } from './cc.common.js';

export const caseRoutes = express.Router();

const none = z.object({}).strict();
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid }).strict();
const text = (min, max) => z.string().trim().min(min).max(max).regex(/^[^\p{Cc}]*$/u, 'Contains control characters');
const KINDS = ['SUPPORT', 'INCIDENT'];
const PRIORITIES = ['P1', 'P2', 'P3', 'P4'];
const STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED'];
const OPEN = ['OPEN', 'IN_PROGRESS', 'WAITING'];
export const CATEGORIES = ['ORDER', 'DELIVERY', 'PAYMENT', 'REFUND', 'ACCOUNT', 'CONSULTATION', 'PRESCRIPTION', 'PHARMACY', 'DOCTOR', 'PRIVACY', 'TECHNICAL', 'NOTIFICATION', 'OTHER'];
/** Hours to resolve, by kind and priority. */
const SLA_HOURS = { SUPPORT: { P1: 4, P2: 24, P3: 72, P4: 120 }, INCIDENT: { P1: 1, P2: 4, P3: 24, P4: 72 } };
const TRANSITIONS = { OPEN: ['IN_PROGRESS', 'WAITING', 'RESOLVED'], IN_PROGRESS: ['WAITING', 'RESOLVED'], WAITING: ['IN_PROGRESS', 'RESOLVED'], RESOLVED: ['CLOSED', 'IN_PROGRESS'], CLOSED: [] };
const READ = ['platform.support.manage', 'platform.ops.read'];

async function staffWith(permission, userId) {
  try {
    return (await platformAccessFor(userId)).permissions.includes(permission);
  } catch {
    return false;
  }
}

caseRoutes.get('/', allow(...READ),
  validate(z.object({
    query: z.object({
      kind: z.enum(KINDS).optional(), status: z.enum([...STATUSES, 'ACTIVE']).optional(), priority: z.enum(PRIORITIES).optional(), category: z.enum(CATEGORIES).optional(),
      assignee: z.union([uuid, z.literal('me'), z.literal('none')]).optional(), subjectUserId: uuid.optional(), orderId: uuid.optional(), q: z.string().trim().max(80).optional(),
      overdue: z.enum(['true', 'false']).optional(), ...pageQuery,
    }).strict(),
    params: none,
  }).passthrough()),
  handle(async (req) => {
    const { kind, status, priority, category, assignee, subjectUserId, orderId, q, overdue, page, limit } = req.query;
    const where = {
      ...(kind ? { kind } : {}), ...(priority ? { priority } : {}), ...(category ? { category } : {}),
      ...(status === 'ACTIVE' ? { status: { in: OPEN } } : status ? { status } : {}),
      ...(assignee === 'me' ? { assigneeUserId: req.user.id } : assignee === 'none' ? { assigneeUserId: null } : assignee ? { assigneeUserId: assignee } : {}),
      ...(subjectUserId ? { subjectUserId } : {}), ...(orderId ? { orderId } : {}),
      ...(overdue === 'true' ? { status: { in: OPEN }, dueAt: { lt: new Date() } } : {}),
      ...(q ? { OR: [{ reference: { contains: q, mode: 'insensitive' } }, { title: { contains: q, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total, counts] = await Promise.all([
      prisma.opsCase.findMany({ where, orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
      prisma.opsCase.count({ where }),
      prisma.opsCase.groupBy({ by: ['kind', 'status'], where: { status: { in: OPEN } }, _count: { _all: true } }),
    ]);
    const names = await namesFor(prisma, rows.flatMap((c) => [c.assigneeUserId, c.createdByUserId, c.subjectUserId]));
    const now = new Date();
    return {
      ...paged(rows.map((c) => ({ ...c, assignee: names.get(c.assigneeUserId) ?? null, createdBy: names.get(c.createdByUserId), subject: names.get(c.subjectUserId) ?? null, overdue: OPEN.includes(c.status) && c.dueAt && c.dueAt < now })), total, { page, limit }),
      open: Object.fromEntries(KINDS.map((k) => [k, counts.filter((r) => r.kind === k).reduce((n, r) => n + r._count._all, 0)])),
    };
  }));

caseRoutes.post('/', allow('platform.support.manage'),
  validate(z.object({
    body: z.object({
      kind: z.enum(KINDS), category: z.enum(CATEGORIES), priority: z.enum(PRIORITIES), title: text(5, 160), description: text(10, 2000),
      subjectUserId: uuid.optional(), orderId: uuid.optional(), pharmacyId: uuid.optional(), professionalProfileId: uuid.optional(), assigneeUserId: uuid.optional(),
    }).strict(),
    query: none, params: none,
  })),
  handle(async (req, res) => {
    const b = req.body;
    const checks = await Promise.all([
      b.subjectUserId ? prisma.user.findUnique({ where: { id: b.subjectUserId }, select: { id: true } }) : true,
      b.orderId ? prisma.order.findUnique({ where: { id: b.orderId }, select: { id: true } }) : true,
      b.pharmacyId ? prisma.pharmacy.findUnique({ where: { id: b.pharmacyId }, select: { id: true } }) : true,
      b.professionalProfileId ? prisma.professionalProfile.findUnique({ where: { id: b.professionalProfileId }, select: { id: true } }) : true,
      b.assigneeUserId ? staffWith('platform.support.manage', b.assigneeUserId) : true,
    ]);
    const missing = ['patient', 'order', 'pharmacy', 'doctor', 'assignee'].filter((_, i) => !checks[i]);
    if (missing.length) throw ccError('INVALID_LINK', 400, `Not found or not eligible: ${missing.join(', ')}.`);
    const now = new Date();
    const created = await prisma.$transaction(async (tx) => {
      const c = await tx.opsCase.create({
        data: {
          reference: `${b.kind === 'INCIDENT' ? 'INC' : 'CASE'}-${randomBytes(4).toString('hex').toUpperCase()}`, kind: b.kind, category: b.category, priority: b.priority, title: b.title,
          subjectUserId: b.subjectUserId ?? null, orderId: b.orderId ?? null, pharmacyId: b.pharmacyId ?? null, professionalProfileId: b.professionalProfileId ?? null,
          assigneeUserId: b.assigneeUserId ?? null, createdByUserId: req.user.id, createdAt: now, dueAt: new Date(now.getTime() + SLA_HOURS[b.kind][b.priority] * 3_600_000),
          events: { create: [{ actorUserId: req.user.id, kind: 'CREATED', body: b.description, toStatus: 'OPEN' }] },
        },
      });
      await adminAudit(tx, req, { summary: `Opened ${b.kind.toLowerCase()} ${c.reference}: ${b.title}`, subjectUserId: b.subjectUserId ?? null, resourceType: 'ops_case', resourceId: c.id });
      return c;
    });
    res.status(201);
    return created;
  }));

caseRoutes.get('/:id', allow(...READ),
  validate(z.object({ query: none, params: idParams }).passthrough()),
  handle(async (req) => {
    const c = await prisma.opsCase.findUnique({ where: { id: req.params.id }, include: { events: { orderBy: { createdAt: 'asc' } } } });
    if (!c) throw ccError('NOT_FOUND', 404, 'Case not found.');
    const [order, pharmacy, doctor] = await Promise.all([
      c.orderId ? prisma.order.findUnique({ where: { id: c.orderId }, select: { id: true, reference: true, status: true } }) : null,
      c.pharmacyId ? prisma.pharmacy.findUnique({ where: { id: c.pharmacyId }, select: { id: true, name: true, complianceStatus: true } }) : null,
      c.professionalProfileId ? prisma.professionalProfile.findUnique({ where: { id: c.professionalProfileId }, select: { id: true, verificationStatus: true, user: { select: { full_name: true } } } }) : null,
    ]);
    const names = await namesFor(prisma, [c.assigneeUserId, c.createdByUserId, c.subjectUserId, ...c.events.map((e) => e.actorUserId)]);
    return {
      ...c, assignee: names.get(c.assigneeUserId) ?? null, createdBy: names.get(c.createdByUserId), subject: c.subjectUserId ? { id: c.subjectUserId, name: names.get(c.subjectUserId) } : null,
      order, pharmacy, doctor: doctor ? { id: doctor.id, name: doctor.user.full_name, status: doctor.verificationStatus } : null,
      overdue: OPEN.includes(c.status) && c.dueAt && c.dueAt < new Date(),
      events: c.events.map((e) => ({ ...e, actor: names.get(e.actorUserId) ?? 'Unknown' })),
      allowedTransitions: TRANSITIONS[c.status],
    };
  }));

/** One change at a time, guarded by the case version so two people cannot overwrite each other. */
caseRoutes.post('/:id/update', allow('platform.support.manage'),
  validate(z.object({
    body: z.object({
      version: z.number().int().min(1),
      note: text(2, 2000).optional(),
      status: z.enum(STATUSES).optional(),
      resolution: text(10, 1000).optional(),
      priority: z.enum(PRIORITIES).optional(),
      assigneeUserId: z.union([uuid, z.null()]).optional(),
    }).strict().refine((b) => b.note || b.status || b.priority || b.assigneeUserId !== undefined, { message: 'Nothing to change' }),
    query: none, params: idParams,
  })),
  handle(async (req) => {
    const b = req.body;
    if (b.assigneeUserId && !(await staffWith('platform.support.manage', b.assigneeUserId))) throw ccError('INVALID_LINK', 400, 'That person cannot work on support cases.');
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ops_cases" WHERE "id" = ${req.params.id} FOR UPDATE`;
      const c = await tx.opsCase.findUnique({ where: { id: req.params.id } });
      if (!c) throw ccError('NOT_FOUND', 404, 'Case not found.');
      if (c.version !== b.version) throw ccError('STALE', 409, 'Someone else changed this case. Refresh to see their change.', { version: c.version });
      const events = [];
      const data = { version: { increment: 1 } };
      if (b.status && b.status !== c.status) {
        if (!TRANSITIONS[c.status].includes(b.status)) throw ccError('INVALID_STATE', 409, `A ${c.status.toLowerCase().replace('_', ' ')} case cannot move to ${b.status.toLowerCase().replace('_', ' ')}.`);
        if (['RESOLVED', 'CLOSED'].includes(b.status) && !(b.resolution || c.resolution)) throw ccError('RESOLUTION_REQUIRED', 400, 'Write what was done to resolve it.');
        Object.assign(data, { status: b.status, ...(b.resolution ? { resolution: b.resolution } : {}), resolvedAt: b.status === 'RESOLVED' ? new Date() : b.status === 'IN_PROGRESS' ? null : c.resolvedAt });
        events.push({ kind: 'STATUS', fromStatus: c.status, toStatus: b.status, body: b.resolution ?? null });
      }
      if (b.priority && b.priority !== c.priority) {
        data.priority = b.priority;
        data.dueAt = new Date(c.createdAt.getTime() + SLA_HOURS[c.kind][b.priority] * 3_600_000);
        events.push({ kind: 'PRIORITY', body: `${c.priority} → ${b.priority}` });
      }
      if (b.assigneeUserId !== undefined && b.assigneeUserId !== c.assigneeUserId) {
        data.assigneeUserId = b.assigneeUserId;
        const names = await namesFor(tx, [b.assigneeUserId]);
        events.push({ kind: 'ASSIGNED', body: b.assigneeUserId ? `Assigned to ${names.get(b.assigneeUserId)}` : 'Unassigned' });
      }
      if (b.note) events.push({ kind: 'NOTE', body: b.note });
      if (!events.length) throw ccError('NO_CHANGE', 400, 'Nothing changed.');
      const updated = await tx.opsCase.update({ where: { id: c.id }, data });
      await tx.opsCaseEvent.createMany({ data: events.map((e) => ({ caseId: c.id, actorUserId: req.user.id, ...e })) });
      await adminAudit(tx, req, { summary: `Updated ${c.reference}: ${events.map((e) => e.kind.toLowerCase()).join(', ')}`, subjectUserId: c.subjectUserId, resourceType: 'ops_case', resourceId: c.id,
        before: { status: c.status, priority: c.priority, assigneeUserId: c.assigneeUserId }, after: { status: updated.status, priority: updated.priority, assigneeUserId: updated.assigneeUserId } });
      return updated;
    });
  }));

/** Staff who can be assigned support cases. */
caseRoutes.get('/meta/assignees', allow(...READ),
  validate(z.object({ query: none, params: none }).passthrough()),
  handle(async () => {
    const roles = await prisma.accessRolePermission.findMany({ where: { permissionCode: 'platform.support.manage' }, select: { roleCode: true } });
    const people = await prisma.platformRoleAssignment.findMany({ where: { roleCode: { in: roles.map((r) => r.roleCode) }, user: { accountStatus: 'ACTIVE' } }, select: { userId: true }, distinct: ['userId'] });
    const names = await namesFor(prisma, people.map((p) => p.userId));
    return { items: people.map((p) => ({ id: p.userId, name: names.get(p.userId) })).sort((a, b) => String(a.name).localeCompare(String(b.name))), categories: CATEGORIES, slaHours: SLA_HOURS };
  }));
