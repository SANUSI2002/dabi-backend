import express from "express";
import { Buffer } from "node:buffer";
import { randomUUID } from 'node:crypto';
import { z } from "zod";
import prisma from "../../config/db.js";
import { protect } from "../../middleware/authMiddleware.js";
import { validate } from "../../middleware/validateMiddleware.js";
import {
  registrationLimiter,
  verificationRequestLimiter,
  verificationConfirmLimiter,
  createLimiter,
  sensitiveLimiter,
} from "../../middleware/rateLimitMiddleware.js";
import {
  requirePlatform,
  requirePermission,
} from "../../middleware/accessMiddleware.js";
import { requireRecentMfa } from "../../middleware/mfaMiddleware.js";
import * as S from "./portal.service.js";
import {
  fail,
  clean,
  latestCredentials,
  pharmacyBlockers,
} from "./portal.policy.js";
import * as auth from "../auth/auth.model.js";
import { reserveMarketplace } from "./marketplace.reservations.js";
import * as clinical from "./portal.clinical.js";
import * as prescriptionRequests from "../pharmacy-requests/pharmacy-requests.service.js";
import { quote as quoteSchema } from "../pharmacy-requests/pharmacy-requests.validator.js";
import { queueDecisionEmail } from './portal.email.js';
import * as reports from './portal.reports.js';

export const pharmacyPortalRoutes = express.Router();
export const marketplaceRoutes = express.Router();
export const platformPharmacyRoutes = express.Router();
const text = (min = 2, max = 120) => z.string().trim().min(min).max(max);
const date = z.iso.datetime();
const empty = z.object({}).strict();
const idParams = z.object({
  params: z.object({ id: z.uuid(), docId: z.uuid().optional() }).strict(),
});
const body = (value) => z.object({ body: value });
const pageSchema = z.object({
  query: z
    .object({ page: z.coerce.number().int().min(1).max(10000).default(1) })
    .strict(),
});
const wrap = (fn) => async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  try {
    await fn(req, res);
  } catch (e) {
    if (e.status)
      return res.status(e.status).json({ status: "error", message: e.message });
    if (e.code === "INVALID" || e.code === "NOT_FOUND")
      return res
        .status(e.code === "NOT_FOUND" ? 404 : 400)
        .json({
          status: "error",
          message:
            e.code === "NOT_FOUND"
              ? "The requested record is not available to this account."
              : "The quote does not match the prescription or available inventory. Refresh and check each line.",
        });
    if (e.code === "P2002")
      return res.status(409).json({
        status: "error",
        message: "This account or record already exists.",
      });
    if (e.name === "PrivateStorageError")
      return res.status(503).json({
        status: "error",
        message: "Secure document storage is unavailable. Please retry later.",
      });
    return res.status(503).json({
      status: "error",
      message: "The pharmacy service is temporarily unavailable. Please retry.",
    });
  }
};
const registration = body(
  z
    .object({
      email: z.email().transform((e) => e.toLowerCase()),
      password: z
        .string()
        .min(12)
        .max(128)
        .regex(/[a-z]/)
        .regex(/[A-Z]/)
        .regex(/[0-9]/),
      fullName: text(3, 160),
      phoneNumber: text(7, 30),
      name: text(3, 160),
      address: text(5, 300),
      country: z.literal("Nigeria"),
      state: text(2, 80),
      city: text(2, 80),
      contactEmail: z.email(),
      contactPhone: text(7, 30),
      tierLevel: z.number().int().min(1).max(3),
      regulatory: z
        .object({
          cacNumber: text(3, 100),
          superintendentName: text(3, 160),
          superintendentRegistrationNumber: text(3, 100),
          superintendentLicenceExpiresAt: date,
        })
        .strict(),
      termsAccepted: z.literal(true),
      privacyAccepted: z.literal(true),
    })
    .strict(),
);
pharmacyPortalRoutes.get(
  "/registration-config",
  wrap(async (req, res) =>
    res.json({
      data: {
        tiers: await prisma.pharmacyTier.findMany({
          where: { enabled: true },
          orderBy: { level: "asc" },
        }),
        requiredDocuments: [
          "CAC_CERTIFICATE",
          "SUPERINTENDENT_LICENCE",
          "SUPERINTENDENT_APPOINTMENT",
          "PREMISES_LICENCE",
        ],
        maxUploadBytes: Math.min(
          (
            await import("../../config/evidenceScanner.js")
          ).evidenceUploadMaxBytes(),
          5 * 1024 * 1024,
        ),
      },
    }),
  ),
);
pharmacyPortalRoutes.post(
  "/register",
  registrationLimiter,
  validate(registration),
  wrap(async (req, res) =>
    res.status(201).json({ data: await S.register(req.body) }),
  ),
);
pharmacyPortalRoutes.post(
  "/resend-verification",
  verificationRequestLimiter,
  validate(body(z.object({ email: z.email() }).strict())),
  wrap(async (req, res) => {
    const user = await auth.findUserByEmail(req.body.email.toLowerCase());
    if (
      user?.accountStatus === "PENDING" &&
      !user.emailVerifiedAt &&
      user.roles.some((r) => r.role === "PHARMACY_ADMIN")
    ) {
      const latest = await auth.latestEmailVerificationToken(user.id);
      if (!latest || latest.createdAt < new Date(Date.now() - 60000))
        await S.sendVerification(user).catch(() => false);
    }
    res.status(202).json({
      message:
        "If an eligible unverified pharmacy account exists, a verification email has been requested.",
    });
  }),
);
pharmacyPortalRoutes.post(
  "/verify-email",
  verificationConfirmLimiter,
  validate(
    body(
      z
        .object({ uid: z.uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict(),
    ),
  ),
  wrap(async (req, res) => {
    const p = await prisma.pharmacy.findFirst({
      where: { adminUserId: req.body.uid },
      select: { id: true },
    });
    if (
      !p ||
      !(await auth.confirmEmailVerificationToken(
        req.body.uid,
        S.hash(req.body.token),
      ))
    )
      fail(
        "This link is invalid, expired or already used. Request a fresh verification email.",
        400,
      );
    res.json({ data: { verified: true } });
  }),
);
pharmacyPortalRoutes.use(protect);
const stockQuery = z.object({ query: z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1), branchId: z.uuid().optional(),
  search: z.string().trim().max(100).optional(), state: z.enum(['ALL','LOW','OUT','EXPIRING','EXPIRED','INACTIVE']).default('ALL'),
  expiryDays: z.coerce.number().int().min(1).max(365).default(90),
}).strict() });
const salesQuery = z.object({ query: z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  branchId: z.uuid().optional(), page: z.coerce.number().int().min(1).max(10000).default(1),
}).strict() });
const exportLimiter = createLimiter({ kind: 'pharmacy-report-export', max: 10 });
pharmacyPortalRoutes.get('/stock', validate(stockQuery), wrap(async (req,res) => res.json({ data: await reports.stockReport(req.user.id,req.user.organizationId,req.query) })));
pharmacyPortalRoutes.get('/stock/export', exportLimiter, validate(stockQuery), wrap(async (req,res) => {
  const csv = await reports.stockReport(req.user.id,req.user.organizationId,req.query,{ csv: true });
  res.type('text/csv').set('Content-Disposition','attachment; filename="sabi-pharmacy-stock.csv"').set('X-Content-Type-Options','nosniff').send(csv);
}));
pharmacyPortalRoutes.patch('/inventory/:id/reorder-policy', sensitiveLimiter, validate(idParams), validate(body(z.object({
  reorderPoint: z.number().int().min(0).max(1000000), reorderTarget: z.number().int().min(0).max(1000000).nullable(), version: z.number().int().positive(), reason: text(10,1000),
}).strict())), wrap(async (req,res) => res.json({data:await reports.stockPolicy(req.user.id,req.user.organizationId,req.params.id,req.body)})));
pharmacyPortalRoutes.get('/inventory/:id/adjustments', validate(idParams), validate(pageSchema), wrap(async (req,res) => res.json({data:await reports.adjustmentHistory(req.user.id,req.user.organizationId,req.params.id,req.query.page)})));
pharmacyPortalRoutes.get('/reports/sales', validate(salesQuery), wrap(async (req,res) => res.json({data:await reports.salesReport(req.user.id,req.user.organizationId,req.query)})));
pharmacyPortalRoutes.get('/reports/sales/export', exportLimiter, validate(salesQuery), wrap(async (req,res) => {
  const csv = await reports.salesReport(req.user.id,req.user.organizationId,req.query,{csv:true});
  res.type('text/csv').set('Content-Disposition','attachment; filename="sabi-pharmacy-sales.csv"').set('X-Content-Type-Options','nosniff').send(csv);
}));
pharmacyPortalRoutes.get('/communications', validate(pageSchema), wrap(async (req,res) => {
  const p = await prisma.$transaction(tx=>S.owner(tx,req.user.id,req.user.organizationId));
  const items=await prisma.pharmacyEmailJob.findMany({where:{pharmacyId:p.id},select:{id:true,kind:true,status:true,attempts:true,lastErrorCode:true,createdAt:true,sentAt:true},orderBy:[{createdAt:'desc'},{id:'desc'}],take:51,skip:(req.query.page-1)*50});
  res.json({data:{items:items.slice(0,50),nextPage:items.length>50?req.query.page+1:null}});
}));
const renewedDate = date.refine(
  (value) => new Date(value) > new Date(),
  "Use a future licence expiry date.",
);
pharmacyPortalRoutes.patch(
  "/branches/:id",
  sensitiveLimiter,
  validate(idParams),
  validate(
    body(
      z
        .object({
          name: text(2, 120),
          address: text(5, 300),
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
          premisesLicenceNumber: text(3, 100),
          licenceExpiresAt: renewedDate,
          version: z.number().int().positive(),
          reason: text(10, 1000),
        })
        .strict(),
    ),
  ),
  wrap(async (req, res) =>
    res.json({
      data: await S.renewCredentials(
        req.user.id,
        req.user.organizationId,
        req.body,
        req.params.id,
      ),
    }),
  ),
);
pharmacyPortalRoutes.patch(
  "/superintendent",
  sensitiveLimiter,
  validate(
    body(
      z
        .object({
          superintendentName: text(3, 160),
          superintendentRegistrationNumber: text(3, 100),
          superintendentLicenceExpiresAt: renewedDate,
          reason: text(10, 1000),
        })
        .strict(),
    ),
  ),
  wrap(async (req, res) =>
    res.json({
      data: await S.renewCredentials(
        req.user.id,
        req.user.organizationId,
        req.body,
      ),
    }),
  ),
);
pharmacyPortalRoutes.get(
  "/workspaces",
  wrap(async (req, res) =>
    res.json({ data: await clinical.workspaces(req.user.id) }),
  ),
);
pharmacyPortalRoutes.post(
  "/pharmacists/invite",
  validate(body(z.object({ email: z.email() }).strict())),
  wrap(async (req, res) =>
    res.status(201).json({
      data: await clinical.invitePharmacist(
        req.user.id,
        req.user.organizationId,
        req.body.email,
      ),
    }),
  ),
);
pharmacyPortalRoutes.post(
  "/pharmacists/:id/accept",
  validate(idParams),
  validate(body(empty)),
  wrap(async (req, res) =>
    res.json({
      data: await clinical.acceptPharmacist(req.user.id, req.params.id),
    }),
  ),
);
const clinicalQuery = z.object({
  query: z.object({ pharmacyId: z.uuid() }).strict(),
});
pharmacyPortalRoutes.get(
  "/staff/inventory",
  validate(
    z.object({
      query: z
        .object({
          pharmacyId: z.uuid(),
          page: z.coerce.number().int().min(1).max(10000).default(1),
        })
        .strict(),
    }),
  ),
  wrap(async (req, res) => {
    const p = await prisma.pharmacy.findFirst({
      where: {
        id: req.query.pharmacyId,
        complianceStatus: "VERIFIED",
        identityOrganization: {
          ...(req.user.organizationId ? { id: req.user.organizationId } : {}),
          memberships: {
            some: {
              userId: req.user.id,
              status: "ACTIVE",
              user: { accountStatus: "ACTIVE" },
              roles: { some: { roleCode: "PHARMACY_STAFF" } },
            },
          },
        },
      },
      select: { id: true },
    });
    if (!p)
      fail("An active pharmacy inventory-view membership is required.", 403);
    const items = await prisma.pharmacyInventoryItem.findMany({
      where: { pharmacyId: p.id },
      select: {
        id: true,
        medicationName: true,
        batchNumber: true,
        expiryDate: true,
        availableQuantity: true,
        unitPriceMinor: true,
        isActive: true,
        branch: { select: { name: true } },
      },
      orderBy: { id: "asc" },
      skip: (req.query.page - 1) * 50,
      take: 51,
    });
    await S.audit(prisma, req.user.id, "PHARMACY_STAFF_INVENTORY_VIEWED", {
      pharmacyId: p.id,
      page: req.query.page,
    });
    res.json({
      data: {
        items: items.slice(0, 50),
        nextPage: items.length > 50 ? req.query.page + 1 : null,
      },
    });
  }),
);
pharmacyPortalRoutes.get(
  "/clinical/requests",
  validate(clinicalQuery),
  wrap(async (req, res) =>
    res.json({
      data: await clinical.clinicalRequests(
        req.user.id,
        req.query.pharmacyId,
        req.user.organizationId,
      ),
    }),
  ),
);
pharmacyPortalRoutes.post(
  "/clinical/requests/:id/quotes",
  validate(idParams),
  validate(clinicalQuery),
  validate(body(quoteSchema.shape.body)),
  wrap(async (req, res) => {
    await prisma.$transaction((tx) =>
      clinical.clinicalAccess(
        tx,
        req.user.id,
        req.query.pharmacyId,
        req.user.organizationId,
      ),
    );
    const result = await prescriptionRequests.quote(
      req.user.id,
      req.params.id,
      req.body,
      req.query.pharmacyId,
    );
    res.status(201).json({ data: result });
  }),
);
pharmacyPortalRoutes.get(
  "/clinical/orders",
  validate(clinicalQuery),
  wrap(async (req, res) => {
    const result = await prisma.$transaction(async (tx) => {
      await clinical.clinicalAccess(
        tx,
        req.user.id,
        req.query.pharmacyId,
        req.user.organizationId,
      );
      return tx.orderFulfilment.findMany({
        where: { pharmacyId: req.query.pharmacyId },
        select: {
          id: true,
          status: true,
          fulfilmentMethod: true,
          totalMinor: true,
          patientMessage: true,
          order: { select: { reference: true, status: true } },
          allocations: {
            select: { id: true, medicationName: true, selectedQuantity: true },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
    });
    res.json({ data: { items: result } });
  }),
);
pharmacyPortalRoutes.get(
  "/me",
  wrap(async (req, res) =>
    res.json({ data: await S.me(req.user.id, req.user.organizationId) }),
  ),
);
const branchInput = z
  .object({
    name: text(2, 120),
    address: text(5, 300),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    premisesLicenceNumber: text(3, 100),
    licenceExpiresAt: date,
  })
  .strict();
pharmacyPortalRoutes.post(
  "/branches",
  validate(body(branchInput)),
  wrap(async (req, res) =>
    res.status(201).json({
      data: await S.addBranch(req.user.id, req.user.organizationId, req.body),
    }),
  ),
);
pharmacyPortalRoutes.put(
  "/credentials/:kind",
  createLimiter({ kind: "pharmacy-credential-upload", max: 15 }),
  express.raw({
    type: ["application/pdf", "image/png", "image/jpeg"],
    limit: "5mb",
    inflate: false,
  }),
  wrap(async (req, res) => {
    if (req.query.branchId && !z.uuid().safeParse(req.query.branchId).success)
      fail("Invalid branch.", 400);
    res.status(201).json({
      data: await S.upload(
        req.user.id,
        req.user.organizationId,
        req.params.kind,
        req.query.branchId,
        req.body,
        req.get("Content-Type")?.toLowerCase(),
      ),
    });
  }),
);
pharmacyPortalRoutes.post(
  "/submit",
  validate(body(empty)),
  wrap(async (req, res) =>
    res.json({ data: await S.submit(req.user.id, req.user.organizationId) }),
  ),
);
pharmacyPortalRoutes.get(
  "/catalogue",
  validate(pageSchema),
  wrap(async (req, res) => {
    const p = await prisma.$transaction((tx) =>
      S.owner(tx, req.user.id, req.user.organizationId),
    );
    const rows = await prisma.pharmacyInventoryItem.findMany({
      where: { pharmacyId: p.id },
      select: {
        id: true,
        branchId: true,
        medicationName: true,
        genericName: true,
        batchNumber: true,
        expiryDate: true,
        availableQuantity: true,
        unitPriceMinor: true,
        currency: true,
        isActive: true,
        listing: { select: S.listingSelect },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (req.query.page - 1) * 50,
      take: 51,
    });
    res.json({
      data: {
        items: rows.slice(0, 50),
        nextPage: rows.length > 50 ? req.query.page + 1 : null,
      },
    });
  }),
);
const listingInput = z
  .object({
    branchId: z.uuid(),
    medicationName: text(2, 120),
    genericName: text(2, 120).optional(),
    batchNumber: text(2, 100).nullable().optional(),
    expiryDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(
        (value) =>
          Number.isFinite(new Date(value).getTime()) &&
          new Date(value).toISOString().slice(0, 10) === value,
        "Enter a valid expiry date.",
      )
      .nullable()
      .optional(),
    availableQuantity: z.number().int().min(0).max(1000000),
    unitPriceMinor: z.number().int().min(0).max(1000000000),
    category: z.enum([
      "OTC",
      "DEVICES",
      "BABY",
      "HYGIENE",
      "SUPPLEMENTS",
      "WELLNESS",
    ]),
    description: text(5, 1500),
    productClass: z.enum(["OTC", "PRESCRIPTION_ONLY", "NON_MEDICINAL"]),
    nafdacNumber: text(3, 100).optional(),
  })
  .strict();
pharmacyPortalRoutes.post(
  "/listings",
  validate(body(listingInput)),
  wrap(async (req, res) =>
    res.status(201).json({
      data: await S.createListing(
        req.user.id,
        req.user.organizationId,
        req.body,
      ),
    }),
  ),
);
pharmacyPortalRoutes.post(
  "/inventory/:id/adjust",
  validate(idParams),
  validate(
    body(
      z
        .object({
          idempotencyKey: z.string().min(16).max(128),
          expectedQuantity: z.number().int().min(0).max(1000000),
          quantityDelta: z
            .number()
            .int()
            .min(-1000000)
            .max(1000000)
            .refine((n) => n !== 0),
          reason: text(10, 1000),
        })
        .strict(),
    ),
  ),
  wrap(async (req, res) =>
    res.json({
      data: await S.adjustStock(
        req.user.id,
        req.user.organizationId,
        req.params.id,
        req.body,
      ),
    }),
  ),
);
pharmacyPortalRoutes.patch(
  "/listings/:id",
  validate(idParams),
  validate(
    body(
      listingInput
        .omit({ branchId: true, availableQuantity: true })
        .extend({
          genericName: text(2, 120).nullable().optional(),
          nafdacNumber: text(3, 100).nullable().optional(),
          isActive: z.boolean(),
          version: z.number().int().positive(),
          reason: text(10, 1000),
        })
        .strict(),
    ),
  ),
  wrap(async (req, res) =>
    res.json({
      data: await S.editListing(
        req.user.id,
        req.user.organizationId,
        req.params.id,
        req.body,
      ),
    }),
  ),
);
pharmacyPortalRoutes.post(
  "/listings/:id/withdraw",
  validate(idParams),
  validate(body(z.object({ version: z.number().int().positive() }).strict())),
  wrap(async (req, res) =>
    res.json({
      data: await S.withdrawListing(
        req.user.id,
        req.user.organizationId,
        req.params.id,
        req.body.version,
      ),
    }),
  ),
);
pharmacyPortalRoutes.put(
  "/listings/:id/image",
  createLimiter({ kind: "pharmacy-product-image", max: 30 }),
  validate(idParams),
  express.raw({
    type: ["image/png", "image/jpeg"],
    limit: "3mb",
    inflate: false,
  }),
  wrap(async (req, res) =>
    res.json({
      data: await S.listingImage(
        req.user.id,
        req.user.organizationId,
        req.params.id,
        req.body,
      ),
    }),
  ),
);
pharmacyPortalRoutes.post(
  "/listings/:id/submit",
  validate(idParams),
  validate(body(z.object({ version: z.number().int().positive() }).strict())),
  wrap(async (req, res) =>
    res.json({
      data: await S.submitListing(
        req.user.id,
        req.user.organizationId,
        req.params.id,
        req.body.version,
      ),
    }),
  ),
);
pharmacyPortalRoutes.get(
  "/requests",
  validate(pageSchema),
  wrap(async (req, res) => {
    const p = await prisma.$transaction((tx) =>
      S.owner(tx, req.user.id, req.user.organizationId),
    );
    // An owner sees request references, not a patient's clinical chart. Verified
    // pharmacists use the existing prescription-review/quote permissions.
    const items = await prisma.prescriptionRequest.findMany({
      where: { pharmacyId: p.id },
      select: {
        id: true,
        prescriptionId: true,
        status: true,
        createdAt: true,
        quotes: {
          select: {
            id: true,
            status: true,
            revision: true,
            quoteExpiresAt: true,
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (req.query.page - 1) * 50,
      take: 51,
    });
    res.json({
      data: {
        items: items.slice(0, 50),
        nextPage: items.length > 50 ? req.query.page + 1 : null,
      },
    });
  }),
);
pharmacyPortalRoutes.get(
  "/orders",
  validate(pageSchema),
  wrap(async (req, res) => {
    const p = await prisma.$transaction((tx) =>
      S.owner(tx, req.user.id, req.user.organizationId),
    );
    const items = await prisma.orderFulfilment.findMany({
      where: { pharmacyId: p.id },
      select: {
        id: true,
        status: true,
        fulfilmentMethod: true,
        subtotalMinor: true,
        totalMinor: true,
        commissionBps: true,
        commissionMinor: true,
        createdAt: true,
        order: { select: { reference: true, status: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (req.query.page - 1) * 50,
      take: 51,
    });
    res.json({
      data: {
        items: items.slice(0, 50),
        nextPage: items.length > 50 ? req.query.page + 1 : null,
      },
    });
  }),
);

marketplaceRoutes.get(
  "/products",
  validate(
    z.object({
      query: z
        .object({
          page: z.coerce.number().int().min(1).max(10000).default(1),
          pharmacyId: z.uuid().optional(),
          latitude: z.coerce.number().min(-90).max(90).optional(),
          longitude: z.coerce.number().min(-180).max(180).optional(),
        })
        .strict()
        .refine(
          (q) => (q.latitude === undefined) === (q.longitude === undefined),
          "Provide both coordinates.",
        ),
    }),
  ),
  wrap(async (req, res) => res.json({ data: await S.marketplace(req.query) })),
);
marketplaceRoutes.get(
  "/products/:id/image",
  validate(idParams),
  wrap(async (req, res) => {
    const image = await prisma.pharmacyListing.findFirst({
      where: { id: req.params.id, ...S.publicWhere() },
      select: { imageBytes: true, imageHash: true },
    });
    if (!image?.imageBytes) fail("Product image not found.", 404);
    res
      .set({
        "Content-Type": "image/jpeg",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "no-store",
      })
      .send(Buffer.from(image.imageBytes));
  }),
);
marketplaceRoutes.post(
  "/reservations",
  protect,
  sensitiveLimiter,
  validate(
    body(
      z
        .object({
          idempotencyKey: z.string().min(16).max(128),
          items: z
            .array(
              z
                .object({
                  listingId: z.uuid(),
                  quantity: z.number().int().min(1).max(10000),
                })
                .strict(),
            )
            .min(1)
            .max(50),
        })
        .strict(),
    ),
  ),
  wrap(async (req, res) => {
    const result = await reserveMarketplace(req.user.id, req.body);
    res.status(result.idempotent ? 200 : 201).json({ data: result });
  }),
);

platformPharmacyRoutes.use(
  protect,
  requirePlatform,
  requirePermission("platform.pharmacy.manage"),
  requireRecentMfa,
);
platformPharmacyRoutes.get(
  "/tiers",
  wrap(async (req, res) =>
    res.json({
      data: {
        items: await prisma.pharmacyTier.findMany({
          orderBy: { level: "asc" },
        }),
      },
    }),
  ),
);
const tierInput = z
  .object({
    name: text(3, 80),
    commissionBps: z.number().int().min(0).max(10000),
    deliveryRadiusKm: z.number().int().min(1).max(100),
    maxBranches: z.number().int().min(1).max(10000).nullable(),
    minimumOrderMinor: z.number().int().min(0).max(1000000000),
    deliveryEnabled: z.boolean(),
    pickupEnabled: z.boolean(),
    enabled: z.boolean(),
    version: z.number().int().positive(),
    reason: text(10, 1000),
  })
  .strict();
platformPharmacyRoutes.patch(
  "/tiers/:level",
  sensitiveLimiter,
  validate(
    z.object({
      params: z
        .object({ level: z.coerce.number().int().min(1).max(3) })
        .strict(),
      body: tierInput,
    }),
  ),
  wrap(async (req, res) => {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT level FROM pharmacy_tiers WHERE level=${req.params.level} FOR UPDATE`;
      const prior = await tx.pharmacyTier.findUnique({
        where: { level: req.params.level },
      });
      if (prior.version !== req.body.version)
        fail("This tier changed. Refresh and retry.");
      if (req.body.maxBranches) {
        const counts = await tx.pharmacyBranch.groupBy({
          by: ["pharmacyId"],
          where: { pharmacy: { tierLevel: req.params.level } },
          _count: true,
        });
        if (counts.some((c) => c._count > req.body.maxBranches))
          fail(
            "The new branch limit is below an existing pharmacy branch count. Review their tier assignments first.",
          );
      }
      const { version, reason, ...values } = req.body;
      await tx.pharmacyTier.update({
        where: { level: req.params.level },
        data: { ...values, version: { increment: 1 } },
      });
      await S.audit(tx, req.user.id, "PHARMACY_TIER_UPDATED", {
        level: req.params.level,
        expectedVersion: version,
        prior: {
          version: prior.version,
          commissionBps: prior.commissionBps,
          deliveryRadiusKm: prior.deliveryRadiusKm,
          maxBranches: prior.maxBranches,
        },
        values,
        reason,
      });
      return tx.pharmacyTier.findUnique({ where: { level: req.params.level } });
    });
    res.json({ data: result });
  }),
);
platformPharmacyRoutes.get(
  "/listings",
  validate(pageSchema),
  wrap(async (req, res) => {
    const rows = await prisma.pharmacyListing.findMany({
      where: { status: "SUBMITTED" },
      select: {
        ...S.listingSelect,
        inventoryItem: {
          select: {
            medicationName: true,
            unitPriceMinor: true,
            pharmacy: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip: (req.query.page - 1) * 50,
      take: 51,
    });
    res.json({
      data: {
        items: rows.slice(0, 50),
        nextPage: rows.length > 50 ? req.query.page + 1 : null,
      },
    });
  }),
);
platformPharmacyRoutes.get(
  "/listings/:id/image",
  validate(idParams),
  wrap(async (req, res) => {
    const row = await prisma.pharmacyListing.findUnique({
      where: { id: req.params.id },
      select: { imageBytes: true },
    });
    if (!row?.imageBytes) fail("Image not found.", 404);
    res
      .type("image/jpeg")
      .set("X-Content-Type-Options", "nosniff")
      .send(Buffer.from(row.imageBytes));
  }),
);
platformPharmacyRoutes.get(
  "/listings/:id/image-data",
  validate(idParams),
  wrap(async (req, res) => {
    const row = await prisma.pharmacyListing.findUnique({
      where: { id: req.params.id },
      select: { imageBytes: true },
    });
    if (!row?.imageBytes) fail("Image not found.", 404);
    res.json({
      data: { base64: Buffer.from(row.imageBytes).toString("base64") },
    });
  }),
);
platformPharmacyRoutes.post(
  "/listings/:id/decision",
  sensitiveLimiter,
  validate(idParams),
  validate(
    body(
      z
        .object({
          status: z.enum(["PUBLISHED", "REJECTED"]),
          version: z.number().int().positive(),
          note: text(10, 2000),
        })
        .strict(),
    ),
  ),
  wrap(async (req, res) => {
    await prisma.$transaction(async (tx) => {
      const candidate = await tx.pharmacyListing.findUnique({
        where: { id: req.params.id },
        select: { inventoryItem: { select: { pharmacyId: true } } },
      });
      if (!candidate) fail("Listing not found.", 404);
      await tx.$queryRaw`SELECT id FROM pharmacies WHERE id=${candidate.inventoryItem.pharmacyId} FOR UPDATE`;
      const listing = await tx.pharmacyListing.findUnique({
        where: { id: req.params.id },
        include: {
          inventoryItem: {
            include: { pharmacy: { include: S.pharmacyInclude }, branch: true },
          },
        },
      });
      if (!listing) fail("Listing not found.", 404);
      const p = listing.inventoryItem.pharmacy;
      if (p.adminUserId === req.user.id)
        fail("You cannot review your own listing.", 403);
      if (
        listing.version !== req.body.version ||
        listing.status !== "SUBMITTED"
      )
        fail("This listing changed. Refresh and retry.");
      if (
        req.body.status === "PUBLISHED" &&
        (!listing.imageBytes ||
          listing.productClass === "PRESCRIPTION_ONLY" ||
          p.complianceStatus !== "VERIFIED" ||
          pharmacyBlockers(p).length ||
          listing.inventoryItem.branch?.status !== "VERIFIED")
      )
        fail("This listing is not eligible for publication.");
      const updated = await tx.pharmacyListing.updateMany({
        where: {
          id: listing.id,
          version: req.body.version,
          status: "SUBMITTED",
        },
        data: {
          status: req.body.status,
          reviewedBy: req.user.id,
          reviewedAt: new Date(),
          reviewNote: req.body.note,
          version: { increment: 1 },
        },
      });
      if (!updated.count) fail("Listing changed. Refresh and retry.");
      await S.audit(tx, req.user.id, "PHARMACY_LISTING_DECISION", {
        listingId: listing.id,
        status: req.body.status,
        note: req.body.note,
      });
    });
    res.json({ data: { id: req.params.id, status: req.body.status } });
  }),
);
platformPharmacyRoutes.get(
  "/",
  validate(pageSchema),
  wrap(async (req, res) => {
    const items = await prisma.pharmacy.findMany({
      include: S.pharmacyInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (req.query.page - 1) * 50,
      take: 51,
    });
    res.json({
      data: {
        items: items.slice(0, 50).map(S.pharmacySafe),
        nextPage: items.length > 50 ? req.query.page + 1 : null,
      },
    });
  }),
);
platformPharmacyRoutes.get(
  "/:id",
  validate(idParams),
  wrap(async (req, res) => {
    const p = await prisma.pharmacy.findUnique({
      where: { id: req.params.id },
      include: S.pharmacyInclude,
    });
    if (!p) fail("Pharmacy not found.", 404);
    await S.audit(prisma, req.user.id, "PHARMACY_APPLICATION_VIEWED", {
      pharmacyId: p.id,
    });
    res.json({ data: S.pharmacySafe(p) });
  }),
);
platformPharmacyRoutes.get(
  "/:id/readiness",
  validate(idParams),
  validate(
    z.object({
      query: z
        .object({ tierLevel: z.coerce.number().int().min(1).max(3) })
        .strict(),
    }),
  ),
  wrap(async (req, res) => {
    const p = await prisma.pharmacy.findUnique({
      where: { id: req.params.id },
      include: S.pharmacyInclude,
    });
    if (!p) fail("Pharmacy not found.", 404);
    const tier = await prisma.pharmacyTier.findUnique({
      where: { level: req.query.tierLevel },
    });
    res.json({ data: { blockers: pharmacyBlockers({ ...p, tier }) } });
  }),
);
platformPharmacyRoutes.get(
  "/:id/credentials/:docId/preview",
  validate(idParams),
  wrap(async (req, res) =>
    res.json({
      data: await S.previewCredential(
        req.params.id,
        req.params.docId,
        req.user.id,
      ),
    }),
  ),
);
platformPharmacyRoutes.post(
  "/:id/credentials/:docId/retry-scan",
  sensitiveLimiter,
  validate(idParams),
  validate(body(empty)),
  wrap(async (req, res) => {
    const configured = (
      await import("../../config/evidenceScanner.js")
    ).evidenceScannerConfigured();
    if (!configured)
      fail("Document screening is unavailable. Please retry later.", 503);
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM pharmacies WHERE id=${req.params.id} FOR UPDATE`;
      const p = await tx.pharmacy.findUnique({
        where: { id: req.params.id },
        include: S.pharmacyInclude,
      });
      if (!p) fail("Pharmacy not found.", 404);
      const doc = p.credentials.find((d) => d.id === req.params.docId);
      if (
        !doc ||
        doc.scanStatus !== "FAILED" ||
        !latestCredentials(p.credentials, doc.branchId).some(
          (d) => d.id === doc.id,
        )
      )
        fail("Only the latest failed screening job can be retried.");
      if (
        doc.storageBucket !==
        (await import("../../config/privateStorage.js")).PRIVATE_BUCKETS
          .hospitalEvidenceQuarantine
      )
        fail("The source document is no longer in quarantine.");
      await tx.pharmacyCredential.update({
        where: { id: doc.id },
        data: {
          scanStatus: "PENDING",
          scanAttempts: 0,
          scanLeaseToken: null,
          scanLeaseExpiresAt: null,
          scanErrorCode: null,
        },
      });
      await S.audit(tx, req.user.id, "PHARMACY_SCAN_RETRY_REQUESTED", {
        pharmacyId: p.id,
        credentialId: doc.id,
        priorCode: doc.scanErrorCode,
      });
    });
    res.status(202).json({ data: { queued: true } });
  }),
);
platformPharmacyRoutes.post(
  "/:id/credentials/:docId/review",
  sensitiveLimiter,
  validate(idParams),
  validate(
    body(
      z
        .object({
          decision: z.enum(["VERIFIED", "REJECTED"]),
          sourceName: text(3, 200),
          reference: text(3, 200),
          note: text(10, 2000),
        })
        .strict(),
    ),
  ),
  wrap(async (req, res) => {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM pharmacies WHERE id=${req.params.id} FOR UPDATE`;
      const p = await tx.pharmacy.findUnique({
        where: { id: req.params.id },
        include: S.pharmacyInclude,
      });
      if (!p) fail("Pharmacy not found.", 404);
      if (p.adminUserId === req.user.id)
        fail("You cannot review your own pharmacy.", 403);
      const doc = p.credentials.find((d) => d.id === req.params.docId);
      if (
        !clean(doc) ||
        !latestCredentials(p.credentials, doc.branchId).some(
          (d) => d.id === doc.id,
        )
      )
        fail("Only the latest clean credential can be reviewed.");
      if (doc.reviewStatus !== "PENDING")
        fail("This document has already been reviewed.");
      await tx.pharmacyCredential.update({
        where: { id: doc.id },
        data: {
          reviewStatus: req.body.decision,
          reviewedBy: req.user.id,
          reviewedAt: new Date(),
          sourceName: req.body.sourceName,
          reference: req.body.reference,
          note: req.body.note,
        },
      });
      await S.audit(tx, req.user.id, "PHARMACY_CREDENTIAL_REVIEWED", {
        pharmacyId: p.id,
        credentialId: doc.id,
        ...req.body,
      });
    });
    res.json({ data: { reviewed: true } });
  }),
);
platformPharmacyRoutes.post(
  "/:id/decision",
  sensitiveLimiter,
  validate(idParams),
  validate(
    body(
      z
        .object({
          status: z.enum(["VERIFIED", "REJECTED", "SUSPENDED"]),
          tierLevel: z.number().int().min(1).max(3),
          expectedStatus: z.enum([
            "PENDING",
            "VERIFIED",
            "REJECTED",
            "SUSPENDED",
          ]),
          note: text(10, 2000),
        })
        .strict(),
    ),
  ),
  wrap(async (req, res) => {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM pharmacies WHERE id=${req.params.id} FOR UPDATE`;
      const p = await tx.pharmacy.findUnique({
        where: { id: req.params.id },
        include: S.pharmacyInclude,
      });
      if (!p) fail("Pharmacy not found.", 404);
      if (p.adminUserId === req.user.id)
        fail("You cannot approve your own pharmacy.", 403);
      if (p.complianceStatus !== req.body.expectedStatus)
        fail("Pharmacy status changed. Refresh and retry.");
      const allowed = {
        VERIFIED: ["PENDING", "REJECTED", "SUSPENDED", "VERIFIED"],
        REJECTED: ["PENDING"],
        SUSPENDED: ["VERIFIED"],
      };
      if (
        !allowed[req.body.status].includes(p.complianceStatus) ||
        (req.body.status === p.complianceStatus &&
          req.body.tierLevel === p.tierLevel)
      )
        fail("This compliance transition is not available.");
      await tx.$queryRaw`SELECT level FROM pharmacy_tiers WHERE level=${req.body.tierLevel} FOR SHARE`;
      const tier = await tx.pharmacyTier.findUnique({
        where: { level: req.body.tierLevel },
      });
      if (req.body.status === "VERIFIED") {
        const issues = pharmacyBlockers({ ...p, tier });
        if (issues.length) fail(issues.join(" "));
      }
      await tx.pharmacy.update({
        where: { id: p.id },
        data: {
          complianceStatus: req.body.status,
          tierLevel: req.body.tierLevel,
          decidedByUserId: req.user.id,
          decidedAt: new Date(),
          decisionNote: req.body.note,
        },
      });
      await tx.pharmacyBranch.updateMany({
        where: { pharmacyId: p.id },
        data: { status: req.body.status, version: { increment: 1 } },
      });
      await S.audit(tx, req.user.id, "PHARMACY_COMPLIANCE_DECISION", {
        pharmacyId: p.id,
        ...req.body,
      });
      await queueDecisionEmail(tx, p, req.body.status, randomUUID());
      return { id: p.id, status: req.body.status };
    });
    res.json({ data: result });
  }),
);
