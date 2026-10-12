import express from "express";
import { protect } from "../../middleware/authMiddleware.js";
import { validate } from "../../middleware/validateMiddleware.js";
import * as controller from "./medical-documents.controller.js";
import * as validator from "./medical-documents.validator.js";
import { authenticateScanCallback } from "./medical-documents.scan-auth.js";
import { rateLimit } from 'express-rate-limit';

const moduleError = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ status: 'error', code: 'DOCUMENT_TOO_LARGE', message: 'This file exceeds the upload size limit. Choose a smaller file.' });
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
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(protect);
router.get('/config', controller.config);
router.get('/recipients', controller.recipients);
router.post('/uploads/receive', rateLimit({ windowMs: 15 * 60000, limit: 15, keyGenerator: (req) => req.user.id, standardHeaders: 'draft-8', legacyHeaders: false }), validate(validator.receive), express.raw({ type: ['application/pdf', 'image/png', 'image/jpeg'], limit: validator.intakeLimit() }), controller.receive);
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
router.post('/:id/retry-scan', validate(validator.idParams), controller.retryScan);
router.get('/:id/shares', validate(validator.idParams), controller.shares);
router.post("/:id/shares", validate(validator.share), controller.share);
router.post(
  "/:id/shares/:shareId/revoke",
  validate(validator.shareParams),
  controller.revokeShare,
);
router.delete("/:id", validate(validator.idParams), controller.remove);
router.use(moduleError);
export default router;
