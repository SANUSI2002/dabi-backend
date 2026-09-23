import { z } from 'zod'; const uuid=z.string().uuid();
export const listDoctors=z.object({query:z.object({page:z.coerce.number().int().min(1).max(10000).default(1),limit:z.coerce.number().int().min(1).max(100).default(20),specialty:z.string().trim().min(2).max(120).optional(),search:z.string().trim().min(2).max(80).optional()}).strict()});
export const doctorId=z.object({params:z.object({id:uuid}).strict()}); export const request=z.object({body:z.object({doctorProfileId:uuid}).strict()}); export const relationId=z.object({params:z.object({id:uuid}).strict()});
