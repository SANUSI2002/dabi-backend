import express from "express";
import { protect } from "../../middleware/authMiddleware.js";
import { validate } from "../../middleware/validateMiddleware.js";
import * as schema from "./hospital-enrollments.validator.js";
import * as controller from "./hospital-enrollments.controller.js";
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
  "/:id/approve",
  protect,
  validate(schema.approve),
  controller.approve,
);
router.post("/:id/reject", protect, validate(schema.reject), controller.reject);
router.use(controller.errorHandler);
export default router;
