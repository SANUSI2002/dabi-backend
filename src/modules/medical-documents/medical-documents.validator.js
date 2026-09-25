import { z } from "zod";
import {
  DOCUMENT_CONTENT_TYPES,
  getUploadMaxBytes,
} from "./medical-documents.storage.js";

const uuid = z.uuid();
const kinds = [
  "MEDICAL_RECORD",
  "LAB_RESULT",
  "IMAGING",
  "EXTERNAL_PRESCRIPTION",
  "OTHER",
];
const filename = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .refine(
    (value) =>
      ![...value].some(
        (char) =>
          char.charCodeAt(0) < 32 ||
          char.charCodeAt(0) === 127 ||
          char === "/" ||
          char === "\\",
      ),
    "Invalid filename",
  );
const exactBody = (shape) => z.object(shape).strict();
export const idParams = z.object({ params: z.object({ id: uuid }).strict() });
export const upload = z.object({
  body: exactBody({
    filename,
    contentType: z.enum(DOCUMENT_CONTENT_TYPES),
    byteSize: z
      .number()
      .int()
      .positive()
      .refine((value) => value <= getUploadMaxBytes(), "File is too large"),
    kind: z.enum(kinds),
    medicalRecordId: uuid.optional(),
  }),
});
export const list = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).max(100000).default(1),
      limit: z.coerce.number().int().min(1).max(50).default(20),
      kind: z.enum(kinds).optional(),
      status: z
        .enum([
          "PENDING_UPLOAD",
          "PENDING_SCAN",
          "CLEAN",
          "INFECTED",
          "REJECTED",
          "PENDING_CLINICAL_REVIEW",
        ])
        .optional(),
    })
    .strict(),
});
export const share = z.object({
  params: z.object({ id: uuid }).strict(),
  body: exactBody({
    recipientId: uuid,
    expiresAt: z.iso
      .datetime()
      .refine(
        (value) => new Date(value).getTime() > Date.now(),
        "Expiry must be in the future",
      ),
  }),
});
export const shareParams = z.object({
  params: z.object({ id: uuid, shareId: uuid }).strict(),
});
export const sharedDownload = z.object({
  params: z.object({ shareId: uuid }).strict(),
});
export const scanResultBody = exactBody({
  verdict: z.enum(["CLEAN", "INFECTED", "REJECTED"]),
  validatedContentType: z.enum(DOCUMENT_CONTENT_TYPES),
  byteSize: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  scannerTimestamp: z.iso.datetime(),
});
