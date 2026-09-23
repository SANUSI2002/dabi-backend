import { z } from 'zod';

const uuid = z.string().uuid();
const medicationItem = z.object({
  medicationName: z.string().trim().min(2).max(120),
  dosage: z.string().trim().min(1).max(64),
  frequency: z.enum(['ONCE_DAILY', 'TWICE_DAILY', 'THREE_TIMES_DAILY', 'FOUR_TIMES_DAILY', 'EVERY_4_HOURS', 'EVERY_6_HOURS', 'EVERY_8_HOURS', 'EVERY_12_HOURS', 'AS_NEEDED', 'OTHER']),
  route: z.enum(['ORAL', 'TOPICAL', 'INHALATION', 'SUBCUTANEOUS', 'INTRAMUSCULAR', 'INTRAVENOUS', 'RECTAL', 'OPHTHALMIC', 'OTIC', 'NASAL', 'OTHER']),
  duration: z.string().trim().min(2).max(64),
  quantity: z.number().int().min(1).max(10000),
  indication: z.string().trim().min(2).max(240),
}).strict();
const draftBody = z.object({ patientId: uuid, items: z.array(medicationItem).min(1).max(20), instructions: z.string().trim().max(2000).optional() }).strict();
const editBody = z.object({ items: z.array(medicationItem).min(1).max(20), instructions: z.string().trim().max(2000).optional() }).strict();
const id = z.object({ params: z.object({ id: uuid }).strict() });
const page = z.object({ query: z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict() });
export const createDraft = z.object({ body: draftBody });
export const updateDraft = z.object({ body: editBody, params: id.shape.params });
export const prescriptionId = id;
export const transition = z.object({ params: id.shape.params, body: z.object({}).strict() });
export const list = page;
