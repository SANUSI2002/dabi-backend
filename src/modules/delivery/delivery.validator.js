import { z } from 'zod';

const uuid = z.string().uuid();
const empty = z.object({}).strict();
const params = z.object({ id: uuid }).strict();
const body = (shape) => z.object({ params, query: empty, body: z.object(shape).strict() });
export const id = z.object({ params, query: empty });
export const list = z.object({ query: z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict() });
export const provision = body({ displayName: z.string().trim().min(2).max(120), isActive: z.boolean() });
export const assign = body({ partnerId: uuid });
export const action = body({});
export const reject = body({ reason: z.string().trim().min(1).max(300) });
export const transition = body({ status: z.enum(['PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED']) });
export const location = body({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});
