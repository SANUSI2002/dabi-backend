// /api/v1/command-centre — platform administration with real data behind it:
//   /access      platform roles, their permissions and staff; grant / remove a role (reason, MFA, audited)
//   /sessions    Command Centre staff sessions; sign one out (reason, audited)
//   /security    MFA coverage, failed sign-ins, emergency access, exports, forged webhooks
//   /tenants     Sabi OS customers: package (subscription), limits (licence), modules (entitlements),
//                provisioning and go-live progress, onboarding documents (names only)
//   /analytics   weekly active people by product and weekly activity
import express from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { requireRecentMfa } from '../../middleware/mfaMiddleware.js';
import { allowedPlatformInviteRoles } from '../identity/identity.invitations.js';
import { maskIp } from '../audit/audit.context.js';
import { adminAudit, allow, ccError, deviceName, handle, namesFor, reason } from './cc.common.js';

export const platformAdminRoutes = express.Router();

const none = z.object({}).strict();
const uuid = z.string().uuid();
const DAY = 86_400_000;
const STAFF_READ = allow('platform.staff.invite', 'platform.security.view', 'platform.audit.read', 'platform.users.manage');

// ------------------------------------------------------------------------------------------------
// Roles, permissions and staff
// ------------------------------------------------------------------------------------------------
platformAdminRoutes.get('/access', STAFF_READ, validate(z.object({ query: none, params: none }).passthrough()),
  handle(async (req) => {
    const [roles, staff] = await Promise.all([
      prisma.accessRole.findMany({ where: { scope: 'PLATFORM' }, orderBy: { code: 'asc' }, select: { code: true, description: true, permissions: { select: { permission: { select: { code: true, description: true } } } }, _count: { select: { platformAssignments: true } } } }),
      prisma.user.findMany({ where: { platformRoleAssignments: { some: {} } }, orderBy: { full_name: 'asc' },
        select: { id: true, full_name: true, email: true, accountStatus: true, lastLoginAt: true, mfaTotp: { select: { enabledAt: true } }, platformRoleAssignments: { select: { roleCode: true } } } }),
    ]);
    return {
      roles: roles.map((r) => ({ code: r.code, description: r.description, members: r._count.platformAssignments, permissions: r.permissions.map((p) => p.permission).sort((a, b) => a.code.localeCompare(b.code)) })),
      staff: staff.map((u) => ({ id: u.id, name: u.full_name, email: u.email, accountStatus: u.accountStatus, lastSignInAt: u.lastLoginAt, twoStepVerification: Boolean(u.mfaTotp?.enabledAt), roles: u.platformRoleAssignments.map((a) => a.roleCode) })),
      grantable: req.accessContext.permissions.includes('platform.staff.invite') ? allowedPlatformInviteRoles(req.accessContext) : [],
      note: 'New staff are added by invitation (Internal users). Here you can change the roles of existing staff.',
    };
  }));

for (const action of ['grant', 'remove']) {
  platformAdminRoutes.post(`/access/staff/:userId/${action}`, allow('platform.staff.invite'), requireRecentMfa,
    validate(z.object({ body: z.object({ roleCode: z.string().regex(/^SABI_[A-Z_]{2,40}$/), reason }).strict(), query: none, params: z.object({ userId: uuid }).strict() })),
    handle(async (req) => prisma.$transaction(async (tx) => {
      const { userId } = req.params; const { roleCode } = req.body;
      if (userId === req.user.id) throw ccError('SAME_PERSON', 403, 'You cannot change your own roles.');
      if (!allowedPlatformInviteRoles(req.accessContext).includes(roleCode)) throw ccError('ROLE_SCOPE_DENIED', 403, 'Your role cannot grant or remove that role.');
      const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, full_name: true, accountStatus: true, platformRoleAssignments: { select: { roleCode: true } } } });
      if (!user || !user.platformRoleAssignments.length) throw ccError('NOT_FOUND', 404, 'Not a Sabi staff member. Invite them from Internal users.');
      const before = user.platformRoleAssignments.map((a) => a.roleCode).sort();
      if (action === 'grant') {
        if (before.includes(roleCode)) throw ccError('INVALID_STATE', 409, 'They already have that role.');
        if (user.accountStatus !== 'ACTIVE') throw ccError('INVALID_STATE', 409, 'Their account is not active.');
        await tx.platformRoleAssignment.create({ data: { userId, roleCode } });
      } else {
        if (!before.includes(roleCode)) throw ccError('INVALID_STATE', 409, 'They do not have that role.');
        await tx.platformRoleAssignment.delete({ where: { userId_roleCode: { userId, roleCode } } });
      }
      const after = action === 'grant' ? [...before, roleCode].sort() : before.filter((r) => r !== roleCode);
      await adminAudit(tx, req, { action: 'ADMIN_ACCOUNT_CHANGED', summary: `${action === 'grant' ? 'Granted' : 'Removed'} ${roleCode} ${action === 'grant' ? 'to' : 'from'} ${user.full_name ?? 'a staff member'}`, subjectUserId: userId, resourceType: 'platform_role', resourceId: userId, reason: req.body.reason, before: { roles: before }, after: { roles: after } });
      return { userId, roles: after };
    })));
}

// ------------------------------------------------------------------------------------------------
// Staff sessions
// ------------------------------------------------------------------------------------------------
platformAdminRoutes.get('/sessions', STAFF_READ, validate(z.object({ query: z.object({ include: z.enum(['active', 'all']).default('active') }).strict(), params: none }).passthrough()),
  handle(async (req) => {
    const now = new Date();
    const rows = await prisma.authSession.findMany({
      where: { user: { platformRoleAssignments: { some: {} } }, ...(req.query.include === 'active' ? { revokedAt: null, expiresAt: { gt: now } } : { createdAt: { gte: new Date(now - 30 * DAY) } }) },
      orderBy: { lastUsedAt: 'desc' }, take: 200,
      select: { id: true, userId: true, createdAt: true, lastUsedAt: true, expiresAt: true, revokedAt: true, revokedReason: true, mfaVerifiedAt: true, device: { select: { label: true } } },
    });
    const names = await namesFor(prisma, rows.map((r) => r.userId));
    return { items: rows.map((r) => ({ ...r, device: deviceName(r.device.label), staff: names.get(r.userId), current: r.id === req.user.sessionId, state: r.revokedAt ? 'SIGNED_OUT' : r.expiresAt <= now ? 'EXPIRED' : 'ACTIVE' })) };
  }));

platformAdminRoutes.post('/sessions/:id/revoke', allow('platform.users.manage', 'platform.security.view'), requireRecentMfa,
  validate(z.object({ body: z.object({ reason }).strict(), query: none, params: z.object({ id: uuid }).strict() })),
  handle(async (req) => prisma.$transaction(async (tx) => {
    const s = await tx.authSession.findFirst({ where: { id: req.params.id, user: { platformRoleAssignments: { some: {} } } }, select: { id: true, userId: true, revokedAt: true } });
    if (!s) throw ccError('NOT_FOUND', 404, 'Staff session not found.');
    if (s.revokedAt) throw ccError('INVALID_STATE', 409, 'That session has already ended.');
    if (s.id === req.user.sessionId) throw ccError('SAME_PERSON', 403, 'Use Sign out to end your own session.');
    const now = new Date();
    await tx.authSession.update({ where: { id: s.id }, data: { revokedAt: now, revokedReason: 'ADMIN' } });
    await tx.authRefreshCredential.updateMany({ where: { sessionId: s.id, revokedAt: null }, data: { revokedAt: now } });
    await adminAudit(tx, req, { action: 'ADMIN_ACCOUNT_CHANGED', summary: 'Signed a staff member out of one session', subjectUserId: s.userId, resourceType: 'session', resourceId: s.id, reason: req.body.reason });
    return { id: s.id, state: 'SIGNED_OUT' };
  })));

// ------------------------------------------------------------------------------------------------
// Security overview
// ------------------------------------------------------------------------------------------------
platformAdminRoutes.get('/security', allow('platform.security.view', 'platform.audit.read'), validate(z.object({ query: none, params: none }).passthrough()),
  handle(async () => {
    const now = new Date(); const day = new Date(now - DAY); const month = new Date(now - 30 * DAY);
    const [staff, failed, failedAccounts, emergency, unreviewed, exports, staffActions, badHooks, recentFailed] = await Promise.all([
      prisma.user.findMany({ where: { platformRoleAssignments: { some: {} } }, select: { id: true, full_name: true, accountStatus: true, mfaTotp: { select: { enabledAt: true } }, platformRoleAssignments: { select: { roleCode: true } } } }),
      prisma.auditEvent.count({ where: { action: 'SIGN_IN_FAILED', createdAt: { gte: day } } }),
      prisma.auditEvent.groupBy({ by: ['actorUserId'], where: { action: 'SIGN_IN_FAILED', createdAt: { gte: day } }, _count: { _all: true } }),
      prisma.emergencyAccessGrant.count({ where: { startedAt: { gte: month } } }),
      prisma.emergencyAccessGrant.count({ where: { reviewedAt: null } }),
      prisma.auditEvent.count({ where: { action: 'ADMIN_EXPORT', createdAt: { gte: month } } }),
      prisma.auditEvent.count({ where: { category: 'ADMIN', createdAt: { gte: day } } }),
      prisma.paymentWebhookReceipt.count({ where: { outcome: 'REJECTED_SIGNATURE', receivedAt: { gte: month } } }),
      prisma.auditEvent.findMany({ where: { action: 'SIGN_IN_FAILED' }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, actorUserId: true, createdAt: true, ipAddress: true, device: true, city: true, country: true } }),
    ]);
    const names = await namesFor(prisma, recentFailed.map((r) => r.actorUserId));
    const withoutMfa = staff.filter((s) => s.accountStatus === 'ACTIVE' && !s.mfaTotp?.enabledAt);
    const superAdmins = staff.filter((s) => s.accountStatus === 'ACTIVE' && s.platformRoleAssignments.some((r) => r.roleCode === 'SABI_SUPER_ADMIN'));
    return {
      generatedAt: now.toISOString(),
      staff: { total: staff.length, active: staff.filter((s) => s.accountStatus === 'ACTIVE').length, superAdmins: superAdmins.length, withoutTwoStep: withoutMfa.map((s) => ({ id: s.id, name: s.full_name })) },
      signIns: { failed24h: failed, accountsWithFailures24h: failedAccounts.length, recentFailures: recentFailed.map((r) => ({ id: r.id, at: r.createdAt, account: names.get(r.actorUserId), ip: maskIp(r.ipAddress), device: r.device, location: [r.city, r.country].filter(Boolean).join(', ') || null })) },
      staffActivity: { adminActions24h: staffActions, exports30d: exports, emergencyAccess30d: emergency, emergencyAwaitingReview: unreviewed },
      payments: { forgedWebhooks30d: badHooks },
      controls: [
        'Platform sessions require an authenticator (two-step verification) before any Command Centre data loads.',
        'High-impact actions (pricing, refunds, settlements, role changes, exports) need two-step verification in the last 10 minutes.',
        'Sensitive reads and every change record the actor, time, target and stated reason; the audit trail is append-only.',
        'Money actions need two different people (maker-checker).',
      ],
    };
  }));

// ------------------------------------------------------------------------------------------------
// Tenants (Sabi OS customers)
// ------------------------------------------------------------------------------------------------
platformAdminRoutes.get('/tenants', allow('platform.ops.read', 'platform.onboarding.review', 'platform.catalog.manage'), validate(z.object({ query: none, params: none }).passthrough()),
  handle(async () => {
    const now = new Date();
    const rows = await prisma.platformApplication.findMany({
      where: { status: 'APPROVED' }, orderBy: { approvedAt: 'desc' },
      select: { id: true, reference: true, organizationName: true, ownerEmail: true, billingCycle: true, approvedAt: true, setupSentAt: true, setupDeadlineAt: true, setupCompletedAt: true,
        package: { select: { name: true, code: true, branchLimit: true, storageLimitGb: true, supportLevel: true } },
        packageVersion: { select: { version: true, currency: true, monthlyPriceMinor: true, annualPriceMinor: true, moduleKeys: true } },
        approvedOrganisation: { select: { id: true, name: true, type: true, status: true, city: true, identityOrganization: { select: { id: true, _count: { select: { memberships: { where: { status: 'ACTIVE' } } } } } }, onboarding: { select: { createdAt: true, documents: { select: { id: true, key: true, name: true, contentType: true } } } } } },
        _count: { select: { evidence: true } } },
    });
    return {
      generatedAt: now.toISOString(),
      billingNote: 'Subscription prices come from the package version the customer was approved on. Sabi does not yet invoice or collect Sabi OS subscriptions, so there are no invoices or payments to show.',
      items: rows.map((a) => {
        const org = a.approvedOrganisation;
        const setup = a.setupCompletedAt ? 'LIVE' : a.setupSentAt ? (a.setupDeadlineAt && a.setupDeadlineAt < now ? 'SETUP_OVERDUE' : 'SETUP_SENT') : 'APPROVED_NOT_PROVISIONED';
        return {
          applicationId: a.id, reference: a.reference, organisation: org ? { id: org.id, name: org.name, type: org.type, status: org.status, city: org.city } : { name: a.organizationName },
          organizationId: org?.identityOrganization?.id ?? null, activeMembers: org?.identityOrganization?._count.memberships ?? 0, owner: a.ownerEmail,
          subscription: { package: a.package.name, code: a.package.code, version: a.packageVersion.version, billingCycle: a.billingCycle, currency: a.packageVersion.currency, priceMinor: a.billingCycle === 'Annual' ? a.packageVersion.annualPriceMinor : a.packageVersion.monthlyPriceMinor },
          licence: { branches: a.package.branchLimit, storageGb: a.package.storageLimitGb, support: a.package.supportLevel },
          entitlements: a.packageVersion.moduleKeys,
          provisioning: { state: setup, approvedAt: a.approvedAt, setupSentAt: a.setupSentAt, setupDeadlineAt: a.setupDeadlineAt, liveAt: a.setupCompletedAt },
          documents: { onboarding: org?.onboarding?.documents ?? [], applicationEvidence: a._count.evidence },
        };
      }),
    };
  }));

// ------------------------------------------------------------------------------------------------
// Usage analytics
// ------------------------------------------------------------------------------------------------
platformAdminRoutes.get('/analytics', allow('platform.ops.read'), validate(z.object({ query: z.object({ weeks: z.coerce.number().int().min(2).max(26).default(8) }).strict(), params: none }).passthrough()),
  handle(async (req) => {
    const weeks = req.query.weeks;
    const since = new Date(Date.now() - weeks * 7 * DAY);
    const active = await prisma.$queryRaw`
      SELECT to_char(date_trunc('week', e."created_at"), 'YYYY-MM-DD') AS "week",
             COUNT(DISTINCT e."actor_user_id") FILTER (WHERE EXISTS (SELECT 1 FROM "user_roles" r WHERE r."user_id" = e."actor_user_id" AND r."role" = 'PATIENT'))::int AS "patients",
             COUNT(DISTINCT e."actor_user_id") FILTER (WHERE EXISTS (SELECT 1 FROM "professional_profiles" p WHERE p."user_id" = e."actor_user_id"))::int AS "professionals",
             COUNT(DISTINCT e."actor_user_id") FILTER (WHERE EXISTS (SELECT 1 FROM "organization_memberships" m WHERE m."user_id" = e."actor_user_id" AND m."status" = 'ACTIVE'))::int AS "organisationStaff",
             COUNT(DISTINCT e."actor_user_id") FILTER (WHERE EXISTS (SELECT 1 FROM "platform_role_assignments" a WHERE a."user_id" = e."actor_user_id"))::int AS "sabiStaff"
      FROM "audit_events" e
      WHERE e."action" IN ('SIGNED_IN', 'SIGNED_IN_MFA') AND e."created_at" >= ${since}
      GROUP BY 1 ORDER BY 1`;
    const activity = await prisma.$queryRaw`
      SELECT w."week",
        (SELECT COUNT(*) FROM "orders" o WHERE date_trunc('week', o."created_at") = w."start")::int AS "orders",
        (SELECT COUNT(*) FROM "doctor_appointments" d WHERE date_trunc('week', d."created_at") = w."start")::int AS "consultations",
        (SELECT COUNT(*) FROM "prescriptions" p WHERE p."issued_at" IS NOT NULL AND date_trunc('week', p."issued_at") = w."start")::int AS "prescriptions",
        (SELECT COUNT(*) FROM "wellness_bookings" b WHERE date_trunc('week', b."created_at") = w."start")::int AS "wellnessBookings",
        (SELECT COUNT(*) FROM "hospital_appointments" h WHERE date_trunc('week', h."created_at") = w."start")::int AS "hospitalAppointments"
      FROM (SELECT gs AS "start", to_char(gs, 'YYYY-MM-DD') AS "week" FROM generate_series(date_trunc('week', ${since}::timestamp), date_trunc('week', now()), interval '1 week') gs) w
      ORDER BY 1`;
    return {
      generatedAt: new Date().toISOString(), weeks,
      definitions: { active: 'Distinct people with a successful sign-in in the week, by what they are on Sabi (one person can count in more than one group).', activity: 'Records created in the week.' },
      active, activity,
    };
  }));
