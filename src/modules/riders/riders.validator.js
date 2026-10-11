import { z } from "zod";
import { CONSENT_VERSION } from "./riders.policy.js";
const empty = z.object({}).strict();
const text = (max) => z.string().trim().min(2).max(max);
const future = z.iso
  .date()
  .refine(
    (value) => value > new Date().toISOString().slice(0, 10),
    "Use a future expiry date",
  );
const fields = {
  fullName: text(160),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{7,30}$/),
  state: text(100),
  city: text(100),
  vehicleType: z.enum(["MOTORCYCLE", "CAR"]),
  licenceExpiresAt: future,
  insuranceExpiresAt: future,
  consentVersion: z.literal(CONSENT_VERSION),
  consent: z.literal(true),
};
export const registration = z.object({
  query: empty,
  body: z
    .object({
      ...fields,
      email: z
        .email()
        .max(320)
        .transform((value) => value.trim().toLowerCase()),
      password: z
        .string()
        .min(12)
        .max(128)
        .regex(/\d/)
        .regex(/[^A-Za-z0-9]/),
    })
    .strict(),
});
export const application = z.object({
  query: empty,
  body: z.object(fields).strict(),
});
export const details = z.object({
  query: empty,
  body: z.object({ ...fields, version: z.number().int().positive() }).strict(),
});
export const id = z.object({
  params: z.object({ id: z.uuid() }).strict(),
  query: empty,
});
export const credentialId = z.object({
  params: z.object({ id: z.uuid(), credentialId: z.uuid() }).strict(),
  query: empty,
});
export const action = z.object({
  body: z.object({ version: z.number().int().positive() }).strict(),
});
export const decision = z.object({
  body: z
    .object({ version: z.number().int().positive(), reason: text(1000) })
    .strict(),
});
export const review = z.object({
  body: z
    .object({
      version: z.number().int().positive(),
      reviewStatus: z.enum(["VERIFIED", "REJECTED"]),
      sourceName: text(200),
      reference: text(200),
      note: text(1000),
    })
    .strict(),
});
export const verify = z.object({
  query: empty,
  body: z
    .object({ uid: z.uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict(),
});
export const resend = z.object({
  query: empty,
  body: z.object({ email: z.email().max(320) }).strict(),
});
export const list = z.object({
  query: z
    .object({
      status: z
        .enum([
          "DRAFT",
          "SUBMITTED",
          "CHANGES_REQUESTED",
          "APPROVED",
          "REJECTED",
          "SUSPENDED",
        ])
        .default("SUBMITTED"),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
    })
    .strict(),
});
