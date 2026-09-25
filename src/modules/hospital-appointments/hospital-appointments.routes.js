import express from "express";
import { protect } from "../../middleware/authMiddleware.js";
import { validate } from "../../middleware/validateMiddleware.js";
import * as schema from "./hospital-appointments.validator.js";
import * as controller from "./hospital-appointments.controller.js";
const router = express.Router();
router.post("/", protect, validate(schema.create), controller.create);
router.get("/mine", protect, validate(schema.mine), controller.mine);
router.get(
  "/hospital",
  protect,
  validate(schema.hospital),
  controller.hospital,
);
router.get("/:id", protect, validate(schema.detail), controller.detail);
router.post(
  "/:id/confirm",
  protect,
  validate(schema.confirm),
  controller.confirm,
);
router.post("/:id/reject", protect, validate(schema.reject), controller.reject);
router.post(
  "/:id/check-in",
  protect,
  validate(schema.detail),
  controller.checkIn,
);
router.use(controller.errorHandler);
export default router;
