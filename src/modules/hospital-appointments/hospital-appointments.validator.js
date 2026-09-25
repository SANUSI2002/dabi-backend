import { z } from "zod";
const id = z.string().uuid();
const status = z.enum([
  "PENDING",
  "SCHEDULED",
  "REJECTED",
  "CHECKED_IN",
  "CANCELLED",
]);
const paging = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  status: status.optional(),
};
const date = z.string().datetime({ offset: true });
export const create = z.object({
  body: z
    .object({
      hospitalId: id,
      dependentId: id.optional(),
      requestedAt: date,
      appointmentType: z.string().trim().min(2).max(80).optional(),
      reason: z.string().trim().min(2).max(300).optional(),
    })
    .strict(),
});
export const mine = z.object({ query: z.object(paging).strict() });
export const hospital = z.object({ query: z.object(paging).strict() });
export const detail = z.object({ params: z.object({ id }).strict() });
export const confirm = z.object({
  params: z.object({ id }).strict(),
  body: z.object({}).strict(),
});
export const reject = z.object({
  params: z.object({ id }).strict(),
  body: z
    .object({ reason: z.string().trim().min(2).max(300).optional() })
    .strict(),
});
