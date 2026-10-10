import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { Buffer } from "node:buffer";

// Distinct purpose and assignment/stage AAD prevent ciphertext reuse between orders or stages.
const key = () => {
  const value = Buffer.from(
    process.env.ORDER_DELIVERY_ENCRYPTION_KEY || "",
    "base64",
  );
  if (value.length !== 32) throw new Error("Delivery encryption unavailable");
  return value;
};
export const sealCode = (id, stage, code) => {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(`sabi-handover-v1:${id}:${stage}`));
  const bytes = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes]
    .map((b) => b.toString("base64url"))
    .join(".");
};
export const openCode = (id, stage, encrypted) => {
  const [iv, tag, value, extra] = (encrypted || "").split(".");
  if (!iv || !tag || !value || extra !== undefined)
    throw new Error("Invalid handover ciphertext");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(iv, "base64url"),
  );
  cipher.setAAD(Buffer.from(`sabi-handover-v1:${id}:${stage}`));
  cipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    cipher.update(Buffer.from(value, "base64url")),
    cipher.final(),
  ]).toString("utf8");
};
export const newCode = () => String(randomInt(0, 1000000)).padStart(6, "0");
export const equalCode = (a, b) =>
  /^\d{6}$/.test(a || "") &&
  /^\d{6}$/.test(b || "") &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const codeExpiry = (now = new Date()) =>
  new Date(now.getTime() + 48 * 60 * 60 * 1000);
export const codeFields = Object.fromEntries(
  ["pickup", "delivery"].flatMap((stage) =>
    ["Encrypted", "ExpiresAt", "IssuedAt", "Attempts", "LockedUntil"].map(
      (field) => [`${stage}Code${field}`, true],
    ),
  ),
);
export const issueCodes = (id, now = new Date()) => {
  const pickup = newCode();
  let delivery;
  do {
    delivery = newCode();
  } while (delivery === pickup);
  return {
    pickupCodeEncrypted: sealCode(id, "pickup", pickup),
    pickupCodeExpiresAt: codeExpiry(now),
    pickupCodeIssuedAt: now,
    deliveryCodeEncrypted: sealCode(id, "delivery", delivery),
    deliveryCodeIssuedAt: now,
  };
};
