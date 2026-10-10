import express from "express";
import { protect } from "../../middleware/authMiddleware.js";
import { validate } from "../../middleware/validateMiddleware.js";
import * as c from "./delivery.controller.js";
import * as v from "./delivery.validator.js";
import {
  requirePlatform,
  requirePermission,
} from "../../middleware/accessMiddleware.js";
import { requireRecentMfa } from "../../middleware/mfaMiddleware.js";

const router = express.Router();
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use(protect);
// Controlled operations endpoint: configures an existing account, never public signup.
router.put(
  "/operations/partners/:id",
  requireRecentMfa,
  validate(v.provision),
  c.configure,
);
router.put(
  "/platform/partners/:id",
  requirePlatform,
  requirePermission("platform.users.manage"),
  requireRecentMfa,
  validate(v.provision),
  c.configurePlatform,
);
router.get("/partners", validate(v.list), c.partners);
router.post("/fulfilments/:id/assignment", validate(v.assign), c.assign);
router.get("/fulfilments/:id/pickup-code", validate(v.id), c.pickupCode);
router.post(
  "/fulfilments/:id/pickup-code",
  validate(v.action),
  c.rotatePickupCode,
);
router.post(
  "/fulfilments/:id/delivery-code",
  validate(v.action),
  c.rotateDeliveryCode,
);
router.get("/assignments", validate(v.list), c.queue);
router.get("/assignments/:id", validate(v.id), c.detail);
router.post("/assignments/:id/accept", validate(v.action), c.accept);
router.post("/assignments/:id/reject", validate(v.reject), c.reject);
router.post("/assignments/:id/status", validate(v.transition), c.transition);
router.post("/assignments/:id/locations", validate(v.location), c.location);
router.get("/orders/:id/tracking", validate(v.id), c.tracking);
router.get("/orders/:id/delivery-codes", validate(v.id), c.deliveryCodes);
router.use(c.errorHandler);
export default router;
