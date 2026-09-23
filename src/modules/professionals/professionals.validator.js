import { z } from 'zod';
// Canonical API values map one-to-one to the visible professional choices in
// the deployed portal. `THERAPIST` is deliberately not accepted as a public
// type; use `OTHER_HEALTHCARE_PROFESSIONAL` for that visible catch-all choice.
export const PROFESSION_TYPES = ['DOCTOR', 'NURSE', 'DENTIST', 'DERMATOLOGIST', 'PSYCHIATRIST', 'PSYCHOLOGIST', 'PHYSIOTHERAPIST', 'PHARMACIST', 'NUTRITIONIST_DIETITIAN', 'OPTOMETRIST', 'MIDWIFE', 'OTHER_HEALTHCARE_PROFESSIONAL'];
const uuid = z.string().uuid();
export const registerSchema = z.object({ body: z.object({ email: z.string().trim().email().transform((v) => v.toLowerCase()), password: z.string().min(8).max(128), fullName: z.string().trim().min(2).max(120), phoneNumber: z.string().trim().min(7).max(30), professionType: z.enum(PROFESSION_TYPES), registrationNumber: z.string().trim().min(3).max(80), practiceName: z.string().trim().min(2).max(160).optional(), specialty: z.string().trim().min(2).max(120).optional() }).strict() });
export const listSchema = z.object({ query: z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), status: z.enum(['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED']).optional(), professionType: z.enum(PROFESSION_TYPES).optional() }).strict() });
export const decisionSchema = z.object({ params: z.object({ id: uuid }).strict(), body: z.object({ reason: z.string().trim().min(2).max(500).optional() }).strict() });
