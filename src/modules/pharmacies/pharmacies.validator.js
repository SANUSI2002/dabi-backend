import { z } from 'zod';

const uuid = z.string().uuid();
const phone = z.string().trim().regex(/^\+?[0-9][0-9 ()-]{6,29}$/);
const registration = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()), password: z.string().min(12).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/), fullName: z.string().trim().min(2).max(120), phoneNumber: phone,
  name: z.string().trim().min(2).max(160), address: z.string().trim().min(5).max(300), country: z.string().trim().min(2).max(80), state: z.string().trim().min(2).max(100), city: z.string().trim().min(2).max(100), contactEmail: z.string().trim().email().max(254).transform((value) => value.toLowerCase()), contactPhone: phone,
}).strict();
const id = z.object({ id: uuid }).strict();
const pagination = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), country: z.string().trim().min(2).max(80).optional(), state: z.string().trim().min(2).max(100).optional(), city: z.string().trim().min(2).max(100).optional() }).strict();
export const register = z.object({ body: registration });
export const pharmacyId = z.object({ params: id });
export const publicList = z.object({ query: pagination });
export const complianceList = z.object({ query: pagination.extend({ status: z.enum(['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED']).optional() }) });
export const decision = z.object({ params: id, body: z.object({ status: z.enum(['VERIFIED', 'REJECTED', 'SUSPENDED']), note: z.string().trim().min(2).max(500).optional() }).strict() });
