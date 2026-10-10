import express from "express";
import { z } from "zod";
import prisma from "../../config/db.js";
import { protect } from "../../middleware/authMiddleware.js";
import {
  requirePlatform,
  requirePermission,
} from "../../middleware/accessMiddleware.js";
import { requireRecentMfa } from "../../middleware/mfaMiddleware.js";
import { validate } from "../../middleware/validateMiddleware.js";
import { sensitiveLimiter } from "../../middleware/rateLimitMiddleware.js";

export const directorySelect = {
  id: true,
  email: true,
  full_name: true,
  accountStatus: true,
  emailVerifiedAt: true,
  roles: { select: { role: true } },
  platformRoleAssignments: { select: { roleCode: true } },
  identityMemberships: {
    select: {
      id: true,
      status: true,
      roles: { select: { roleCode: true } },
      organization: {
        select: {
          id: true,
          type: true,
          organisation: { select: { name: true } },
          pharmacy: { select: { name: true } },
        },
      },
    },
  },
};
const statuses = [
  "PENDING",
  "ACTIVE",
  "SUSPENDED",
  "LOCKED",
  "DISABLED",
  "DEACTIVATED",
  "BANNED",
];
const router = express.Router();
router.use(
  protect,
  requirePlatform,
  requirePermission("platform.users.read"),
  requireRecentMfa,
);
const wrap = (fn) => async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  try {
    await fn(req, res);
  } catch (e) {
    if (e.status)
      return res.status(e.status).json({ status: "error", message: e.message });
    return res
      .status(503)
      .json({
        status: "error",
        message:
          "The account directory is temporarily unavailable. Please retry.",
      });
  }
};
const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status });
};
const querySchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).max(10000).default(1),
      search: z.string().trim().max(100).optional(),
      status: z.enum(statuses).optional(),
      platform: z
        .enum(["PATIENT", "DOCTOR", "PHARMACY", "HOSPITAL", "PLATFORM"])
        .optional(),
    })
    .strict(),
});
router.get(
  "/",
  validate(querySchema),
  wrap(async (req, res) => {
    const { page, search, status, platform } = req.query;
    const where = {
      ...(status ? { accountStatus: status } : {}),
      ...(search
        ? {
            OR: [
              { email: { contains: search, mode: "insensitive" } },
              { full_name: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(platform === "PATIENT"
        ? { roles: { some: { role: "PATIENT" } } }
        : platform === "DOCTOR"
          ? { professionalProfile: { professionType: "DOCTOR" } }
          : platform === "PLATFORM"
            ? { platformRoleAssignments: { some: {} } }
            : platform
              ? {
                  identityMemberships: {
                    some: { organization: { type: platform } },
                  },
                }
              : {}),
    };
    const rows = await prisma.user.findMany({
      where,
      select: directorySelect,
      orderBy: { id: "asc" },
      skip: (page - 1) * 50,
      take: 51,
    });
    await prisma.activityLog.create({
      data: {
        userId: req.user.id,
        type: "PLATFORM_USER_DIRECTORY_VIEWED",
        description: "Account directory viewed",
        meta: { page, platform: platform || null, status: status || null },
      },
    });
    res.json({
      data: {
        items: rows.slice(0, 50),
        nextPage: rows.length > 50 ? page + 1 : null,
      },
    });
  }),
);

const mutationSchema = z.object({
  params: z.object({ id: z.uuid() }).strict(),
  body: z
    .object({
      status: z.enum(["ACTIVE", "SUSPENDED", "DISABLED", "BANNED"]),
      expectedStatus: z.enum(statuses),
      reason: z.string().trim().min(10).max(1000),
    })
    .strict(),
});
export async function changeAccountStatus(
  actorId,
  targetId,
  input,
  db = prisma,
) {
  if (actorId === targetId)
    fail("You cannot change your own account status.", 403);
  return db.$transaction(async (tx) => {
    // Serialize administrative state changes, so two administrators cannot each
    // disable the other and leave the platform without an active administrator.
    await tx.$queryRaw`SELECT code FROM access_roles WHERE code = 'SABI_PLATFORM_ADMIN' FOR UPDATE`;
    const actor = await tx.user.findUnique({
      where: { id: actorId },
      select: {
        accountStatus: true,
        platformRoleAssignments: {
          select: {
            role: {
              select: { permissions: { select: { permissionCode: true } } },
            },
          },
        },
      },
    });
    if (actor?.accountStatus !== "ACTIVE")
      fail("Your account is no longer active.", 403);
    if (
      !actor.platformRoleAssignments.some((assignment) =>
        assignment.role.permissions.some(
          (permission) => permission.permissionCode === "platform.users.manage",
        ),
      )
    )
      fail("Your account-management permission is no longer available.", 403);
    const target = await tx.user.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        accountStatus: true,
        emailVerifiedAt: true,
        platformRoleAssignments: { select: { roleCode: true } },
      },
    });
    if (!target) fail("Account not found.", 404);
    if (target.accountStatus !== input.expectedStatus)
      fail("This account changed. Refresh before making another decision.");
    if (target.accountStatus === input.status)
      fail("The account already has this status.");
    if (input.status === "ACTIVE" && !target.emailVerifiedAt)
      fail("Verify the account email before restoring access.");
    if (
      input.status !== "ACTIVE" &&
      target.platformRoleAssignments.some(
        (r) => r.roleCode === "SABI_PLATFORM_ADMIN",
      )
    ) {
      const remaining = await tx.user.count({
        where: {
          id: { not: targetId },
          accountStatus: "ACTIVE",
          platformRoleAssignments: {
            some: { roleCode: "SABI_PLATFORM_ADMIN" },
          },
        },
      });
      if (!remaining)
        fail(
          "The last active platform administrator cannot be suspended, disabled or banned.",
        );
    }
    const now = new Date();
    const changed = await tx.user.updateMany({
      where: { id: targetId, accountStatus: input.expectedStatus },
      data: { accountStatus: input.status },
    });
    if (changed.count !== 1) fail("This account changed. Refresh and retry.");
    // Every identity surface uses these same sessions. Restoring an account does
    // not resurrect any old credentials; the person must sign in again.
    await tx.authSession.updateMany({
      where: { userId: targetId, revokedAt: null },
      data: { revokedAt: now, revokedReason: "ACCOUNT_STATUS_CHANGED" },
    });
    await tx.authRefreshCredential.updateMany({
      where: { session: { userId: targetId }, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.refreshToken.deleteMany({ where: { userId: targetId } });
    await tx.activityLog.create({
      data: {
        userId: actorId,
        type: "PLATFORM_USER_STATUS_CHANGED",
        description: "Account access decision recorded",
        meta: {
          targetUserId: targetId,
          from: target.accountStatus,
          to: input.status,
          reason: input.reason,
        },
      },
    });
    return { id: targetId, accountStatus: input.status };
  });
}
router.patch(
  "/:id/status",
  sensitiveLimiter,
  requirePermission("platform.users.manage"),
  validate(mutationSchema),
  wrap(async (req, res) =>
    res.json({
      data: await changeAccountStatus(req.user.id, req.params.id, req.body),
    }),
  ),
);
export default router;
