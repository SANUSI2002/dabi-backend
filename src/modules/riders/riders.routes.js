import express from "express";
import { z } from "zod";
import { protect } from "../../middleware/authMiddleware.js";
import {
  requirePlatform,
  requirePermission,
} from "../../middleware/accessMiddleware.js";
import { requireRecentMfa } from "../../middleware/mfaMiddleware.js";
import { validate } from "../../middleware/validateMiddleware.js";
import {
  registrationLimiter,
  verificationRequestLimiter,
  verificationConfirmLimiter,
  createLimiter,
} from "../../middleware/rateLimitMiddleware.js";
import * as V from "./riders.validator.js";
import * as S from "./riders.service.js";
import { REQUIREMENTS, CONSENT_VERSION } from "./riders.policy.js";
export const riderRoutes = express.Router();
export const platformRiderRoutes = express.Router();
const noStore = (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
};
riderRoutes.use(noStore);
platformRiderRoutes.use(noStore);
const wrap = (handler) => async (req, res) => {
  try {
    const result = await handler(req);
    res.json({ data: result });
  } catch (e) {
    if ([400, 403, 404, 409, 413, 415, 503].includes(e.status))
      return res.status(e.status).json({ status: "error", message: e.message });
    if (e.code === "PRIVATE_STORAGE_UPLOAD_INVALID")
      return res
        .status(400)
        .json({
          status: "error",
          message: "File contents do not match the selected file type.",
        });
    if (e.code === "P2002")
      return res
        .status(409)
        .json({
          status: "error",
          message: "A rider application already exists. Open your application.",
        });
    if (e.name === "PrivateStorageError")
      return res
        .status(503)
        .json({
          status: "error",
          message: "Private document storage unavailable. Please retry.",
        });
    res
      .status(503)
      .json({
        status: "error",
        message: "Rider service temporarily unavailable. Please retry.",
      });
  }
};
riderRoutes.get(
  "/registration-config",
  wrap(() => ({
    enabled: S.enabled(),
    requirements: REQUIREMENTS,
    consentVersion: CONSENT_VERSION,
    maxUploadBytes: S.maxBytes(),
  })),
);
riderRoutes.post(
  "/register",
  registrationLimiter,
  validate(V.registration),
  wrap((req) => S.register(req.body)),
);
riderRoutes.post(
  "/resend-verification",
  verificationRequestLimiter,
  validate(V.resend),
  wrap(async (req) => {
    await S.resend(req.body.email);
    return {
      message:
        "If an eligible unverified rider account exists, a verification email has been requested.",
    };
  }),
);
riderRoutes.post(
  "/verify-email",
  verificationConfirmLimiter,
  validate(V.verify),
  wrap((req) => S.verify(req.body)),
);
riderRoutes.use(protect);
riderRoutes.get(
  "/me",
  validate(z.object({ query: z.object({}).strict() })),
  wrap((req) => S.me(req.user.id)),
);
riderRoutes.post(
  "/applications",
  createLimiter({ kind: "rider-application", max: 10 }),
  validate(V.application),
  wrap((req) => S.createApplication(req.user.id, req.body)),
);
riderRoutes.patch(
  "/applications/:id",
  validate(V.id),
  validate(V.details),
  wrap((req) => S.updateDetails(req.user.id, req.params.id, req.body)),
);
riderRoutes.put(
  "/applications/:id/credentials/:kind",
  createLimiter({ kind: "rider-credential-upload", max: 12 }),
  express.raw({
    type: ["application/pdf", "image/png", "image/jpeg"],
    limit: "5mb",
    inflate: false,
  }),
  wrap((req) => {
    if (
      !z.uuid().safeParse(req.params.id).success ||
      Object.keys(req.query).length
    )
      S.fail("Invalid upload request.", 400);
    return S.upload(
      req.user.id,
      req.params.id,
      req.params.kind,
      req.body,
      req.get("Content-Type")?.toLowerCase(),
    );
  }),
);
riderRoutes.post(
  "/applications/:id/submit",
  createLimiter({ kind: "rider-submit", max: 10 }),
  validate(V.id),
  validate(V.action),
  wrap((req) => S.submit(req.user.id, req.params.id, req.body.version)),
);
platformRiderRoutes.use(
  protect,
  requirePlatform,
  requirePermission("platform.onboarding.review"),
  requireRecentMfa,
);
platformRiderRoutes.get(
  "/",
  validate(V.list),
  wrap((req) => S.queue(req.user.id, req.query)),
);
platformRiderRoutes.get(
  "/:id",
  validate(V.id),
  wrap((req) => S.detail(req.user.id, req.params.id)),
);
platformRiderRoutes.get(
  "/:id/credentials/:credentialId/preview",
  validate(V.credentialId),
  wrap((req) => S.preview(req.user.id, req.params.id, req.params.credentialId)),
);
platformRiderRoutes.use(requirePermission("platform.onboarding.approve"));
platformRiderRoutes.post(
  "/:id/credentials/:credentialId/review",
  validate(V.credentialId),
  validate(V.review),
  wrap((req) =>
    S.review(req.user.id, req.params.id, req.params.credentialId, req.body),
  ),
);
platformRiderRoutes.post(
  "/:id/credentials/:credentialId/retry-scan",
  createLimiter({ kind: "rider-rescan", max: 5 }),
  validate(V.credentialId),
  validate(V.action),
  wrap((req) =>
    S.retryScan(
      req.user.id,
      req.params.id,
      req.params.credentialId,
      req.body.version,
    ),
  ),
);
platformRiderRoutes.post(
  "/:id/approve",
  validate(V.id),
  validate(V.action),
  wrap((req) => S.decide(req.user.id, req.params.id, "APPROVED", req.body)),
);
for (const [path, status] of [
  ["request-changes", "CHANGES_REQUESTED"],
  ["reject", "REJECTED"],
  ["suspend", "SUSPENDED"],
])
  platformRiderRoutes.post(
    `/:id/${path}`,
    validate(V.id),
    validate(V.decision),
    wrap((req) => S.decide(req.user.id, req.params.id, status, req.body)),
  );
