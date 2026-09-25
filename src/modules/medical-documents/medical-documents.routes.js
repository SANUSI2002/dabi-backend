import express from "express";
import { protect } from "../../middleware/authMiddleware.js";
import { validate } from "../../middleware/validateMiddleware.js";
import * as controller from "./medical-documents.controller.js";
import * as validator from "./medical-documents.validator.js";
import { authenticateScanCallback } from "./medical-documents.scan-auth.js";

const moduleError = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  return res
    .status(500)
    .json({
      status: "error",
      code: "MEDICAL_DOCUMENTS_UNAVAILABLE",
      message: "Medical documents module temporarily unavailable",
    });
};

export const internalDocumentScanRoutes = express.Router();
internalDocumentScanRoutes.post(
  "/:id/result",
  express.raw({ type: "application/json", limit: "8kb" }),
  authenticateScanCallback,
  validate(validator.idParams.extend({ body: validator.scanResultBody })),
  controller.scanResult,
);
internalDocumentScanRoutes.use(moduleError);

const router = express.Router();
router.use(protect);
router.get("/emergency-summary.pdf", controller.emergencyPdf);
router.get(
  "/shared-with-me",
  validate(validator.list),
  controller.sharedWithMe,
);
router.post(
  "/shared-with-me/:shareId/download",
  validate(validator.sharedDownload),
  controller.sharedDownload,
);
router.post(
  "/uploads",
  validate(validator.upload),
  controller.initializeUpload,
);
router.get("/", validate(validator.list), controller.list);
router.get("/:id", validate(validator.idParams), controller.detail);
router.post(
  "/:id/complete-upload",
  validate(validator.idParams),
  controller.completeUpload,
);
router.post("/:id/download", validate(validator.idParams), controller.download);
router.post("/:id/shares", validate(validator.share), controller.share);
router.post(
  "/:id/shares/:shareId/revoke",
  validate(validator.shareParams),
  controller.revokeShare,
);
router.delete("/:id", validate(validator.idParams), controller.remove);
router.use(moduleError);
export default router;
