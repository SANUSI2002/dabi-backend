import crypto from "crypto";
import { Buffer } from "node:buffer";

const fail = (res, message = "Invalid scanner authentication") =>
  res
    .status(401)
    .json({ status: "error", code: "INVALID_SCAN_SIGNATURE", message });

export const authenticateScanCallback = (req, res, next) => {
  const secret = process.env.DOCUMENT_SCAN_CALLBACK_SECRET;
  const timestamp = req.get("x-document-scan-timestamp");
  const supplied = req.get("x-document-scan-signature");
  if (
    !secret ||
    secret.length < 32 ||
    !/^\d{10}$/.test(timestamp || "") ||
    !/^sha256=[a-f0-9]{64}$/.test(supplied || "") ||
    !Buffer.isBuffer(req.body)
  )
    return fail(res);
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300)
    return res
      .status(401)
      .json({
        status: "error",
        code: "STALE_SCAN_SIGNATURE",
        message: "Scanner request is stale",
      });
  const digest = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(req.body)
    .digest("hex");
  const received = supplied.slice(7);
  if (
    !crypto.timingSafeEqual(
      Buffer.from(digest, "hex"),
      Buffer.from(received, "hex"),
    )
  )
    return fail(res);
  req.scanReplayDigest = crypto
    .createHash("sha256")
    .update(`${timestamp}:${received}`)
    .digest("hex");
  try {
    req.body = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res
      .status(400)
      .json({
        status: "error",
        code: "INVALID_SCAN_RESULT",
        message: "Invalid scan result",
      });
  }
  return next();
};
