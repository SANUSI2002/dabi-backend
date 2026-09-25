import { z } from "zod";
const id = z.string().uuid();
const page = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
};
const status = z.enum(["PENDING", "CONFIRMED", "REJECTED", "CANCELLED"]);
export const list = z.object({
  query: z
    .object({ ...page, category: z.string().trim().min(2).max(80).optional() })
    .strict(),
});
export const detail = z.object({ params: z.object({ id }).strict() });
export const book = z.object({
  body: z
    .object({
      offeringId: id,
      requestedAt: z.string().datetime({ offset: true }),
      context: z.string().trim().min(2).max(300).optional(),
    })
    .strict(),
});
export const mine = z.object({
  query: z.object({ ...page, status: status.optional() }).strict(),
});
export const decision = z.object({
  params: z.object({ id }).strict(),
  body: z
    .object({ reason: z.string().trim().min(2).max(300).optional() })
    .strict(),
});
