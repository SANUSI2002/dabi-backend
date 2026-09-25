import { z } from "zod";
const empty = z.object({}).strict();
const id = z.object({ id: z.uuid() }).strict();
const page = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
};
const envelope = (params = empty, body = empty.optional(), query = empty) =>
  z.object({ params, body, query });
export const create = envelope(
  empty,
  z
    .object({
      hospitalId: z.uuid(),
      planId: z.uuid(),
      dependentId: z.uuid().optional(),
      patientNote: z.string().trim().min(1).max(500).optional(),
    })
    .strict(),
);
export const mine = envelope(
  empty,
  empty.optional(),
  z
    .object({
      ...page,
      status: z.enum(["PENDING", "ACTIVE", "REJECTED"]).optional(),
    })
    .strict(),
);
export const detail = envelope(id);
export const hospital = envelope(
  empty,
  empty.optional(),
  z
    .object({
      ...page,
      status: z.enum(["PENDING", "ACTIVE", "REJECTED"]).optional(),
    })
    .strict(),
);
export const approve = envelope(id);
export const reject = envelope(
  id,
  z.object({ reason: z.string().trim().min(1).max(500) }).strict(),
);
