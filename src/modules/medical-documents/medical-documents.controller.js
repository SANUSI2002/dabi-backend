import * as service from "./medical-documents.service.js";

const sendError = (error, res, next) => {
  const known = {
    DOCUMENT_STORAGE_UNAVAILABLE: [
      503,
      "DOCUMENT_STORAGE_UNAVAILABLE",
      "Document storage is unavailable",
    ],
    DOCUMENT_STORAGE_ERROR: [
      503,
      "DOCUMENT_STORAGE_UNAVAILABLE",
      "Document storage is unavailable",
    ],
    RESOURCE_NOT_FOUND: [404, "RESOURCE_NOT_FOUND", "Resource not found"],
    INVALID_DOCUMENT_STATE: [
      409,
      "INVALID_DOCUMENT_STATE",
      "Document state does not allow this operation",
    ],
    UPLOAD_OBJECT_INVALID: [
      409,
      "UPLOAD_OBJECT_INVALID",
      "Uploaded object does not match the requested upload",
    ],
    DUPLICATE_SCAN_RESULT: [
      409,
      "DUPLICATE_SCAN_RESULT",
      "Scan result has already been received",
    ],
    INVALID_SCAN_RESULT: [400, "INVALID_SCAN_RESULT", "Invalid scan result"],
  }[error.code];
  if (!known) return next(error);
  return res
    .status(known[0])
    .json({ status: "error", code: known[1], message: known[2] });
};
const action = (handler) => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (error) {
    sendError(error, res, next);
  }
};

export const initializeUpload = action(async (req, res) =>
  res
    .status(201)
    .json({
      status: "success",
      data: await service.initializeUpload(req.user.id, req.body),
    }),
);
export const completeUpload = action(async (req, res) =>
  res.json({
    status: "success",
    data: await service.completeUpload(req.user.id, req.params.id),
  }),
);
export const list = action(async (req, res) =>
  res.json({
    status: "success",
    data: await service.list(req.user.id, req.query),
  }),
);
export const detail = action(async (req, res) =>
  res.json({
    status: "success",
    data: await service.detail(req.user.id, req.params.id),
  }),
);
export const download = action(async (req, res) =>
  res.json({
    status: "success",
    data: await service.ownerDownload(req.user.id, req.params.id),
  }),
);
export const share = action(async (req, res) =>
  res
    .status(201)
    .json({
      status: "success",
      data: await service.createShare(req.user.id, req.params.id, req.body),
    }),
);
export const sharedWithMe = action(async (req, res) =>
  res.json({
    status: "success",
    data: await service.sharedWithMe(req.user.id, req.query),
  }),
);
export const sharedDownload = action(async (req, res) =>
  res.json({
    status: "success",
    data: await service.sharedDownload(req.user.id, req.params.shareId),
  }),
);
export const revokeShare = action(async (req, res) => {
  await service.revokeShare(req.user.id, req.params.id, req.params.shareId);
  res.status(204).end();
});
export const remove = action(async (req, res) => {
  await service.remove(req.user.id, req.params.id);
  res.status(204).end();
});
export const scanResult = action(async (req, res) =>
  res.json({
    status: "success",
    data: await service.recordScanResult(
      req.params.id,
      req.body,
      req.scanReplayDigest,
    ),
  }),
);
export const emergencyPdf = action(async (req, res) => {
  const pdf = await service.emergencyPdf(req.user.id);
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": 'inline; filename="emergency-summary.pdf"',
    "Cache-Control": "no-store, private",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  res.send(pdf);
});
