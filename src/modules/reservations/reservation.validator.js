import { z } from 'zod'; const uuid=z.string().uuid();
export const create=z.object({body:z.object({prescriptionId:uuid,idempotencyKey:z.string().trim().min(16).max(128),allocations:z.array(z.object({prescriptionItemId:uuid,quoteItemId:uuid,selectedQuantity:z.number().int().min(1).max(10000)}).strict()).min(1).max(50)}).strict()});
export const id=z.object({params:z.object({id:uuid}).strict()});
