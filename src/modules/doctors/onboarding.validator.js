import { z } from 'zod';
import { PORTAL_PROFESSIONS, professionDefinition, needsCurrentLicence } from '../professionals/professionCatalog.js';
const text = (max = 160) => z.string().trim().min(1).max(max);
export const registrationSchema = z.object({ body: z.object({
  firstName: text(80), lastName: text(80), email: z.email().max(254).transform((v) => v.toLowerCase()),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/), password: z.string().min(15).max(128),
  specialty: text(100), qualification: text(100), university: text(200),
  graduationYear: z.coerce.number().int().min(1940).max(new Date().getUTCFullYear()),
  registrationNumber: text(60), practiceState: text(100), city: text(100), hospital: z.string().trim().max(160).optional(),
  licenceType: z.enum(['annual', 'life']), licenceExpiry: z.string().optional(),
  declaration: z.literal(true), termsAccepted: z.literal(true), updatesOptIn: z.boolean().default(false),
  country: z.literal('NG'), regulator: z.literal('MDCN'), consentVersion: z.literal('doctor-registration-v1'),
}).strict().refine((v) => v.licenceType !== 'annual' || /^\d{4}-\d{2}-\d{2}$/.test(v.licenceExpiry || '')
  && Number.isFinite(new Date(`${v.licenceExpiry}T00:00:00Z`).getTime())
  && new Date(`${v.licenceExpiry}T00:00:00Z`).toISOString().slice(0, 10) === v.licenceExpiry
  && new Date(`${v.licenceExpiry}T23:59:59.999Z`) >= new Date(), { path: ['licenceExpiry'], message: 'A current licence expiry date is required.' }) });
export const resendSchema = z.object({ body: z.object({ email: z.email().max(254).transform((v) => v.toLowerCase()) }).strict() });
export const verifySchema = z.object({ body: z.object({ uid: z.uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict() });
export const reviewSchema = z.object({ body: z.object({
  reviewStatus: z.enum(['VERIFIED', 'REJECTED']), sourceName: text(160), reference: text(250), note: text(2000).min(20),
}).strict() });
export const decisionSchema = z.object({ body: z.object({ reason: text(2000).min(20) }).strict() });
export const detailsPatchSchema = z.object({ body: z.object({
  qualification: text(100).optional(), university: text(200).optional(), specialty: text(100).optional(), services: text(1000).optional(),
  graduationYear: z.number().int().min(1940).max(new Date().getUTCFullYear()).optional(), yearsOfExperience: z.number().int().min(0).max(70).optional(),
  registrationNumber: text(100).optional(), practiceState: text(100).optional(), city: text(100).optional(), hospital: z.string().trim().max(160).optional(),
  licenceType: z.enum(['annual','life']).optional(), licenceExpiry: z.iso.date().optional(),
}).strict().refine(v=>Object.keys(v).length>0,'Provide the details to update.') });
export const professionalRegistrationSchema = z.object({ body: z.object({
  firstName: text(80), lastName: text(80), email: z.email().max(254).transform((v) => v.toLowerCase()),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/), password: z.string().min(15).max(128),
  professionType: z.enum(PORTAL_PROFESSIONS.filter((p) => p !== 'DOCTOR')), discipline: text(80),
  specialty: text(100), qualification: text(100), university: text(200),
  graduationYear: z.coerce.number().int().min(1940).max(new Date().getUTCFullYear()),
  yearsOfExperience: z.coerce.number().int().min(0).max(70), services: text(1000),
  registrationNumber: z.string().trim().max(100).default(''), practiceState: text(100), city: text(100), hospital: z.string().trim().max(160).optional(),
  licenceType: z.enum(['annual', 'life']).optional(), licenceExpiry: z.string().optional(),
  declaration: z.literal(true), termsAccepted: z.literal(true), country: z.literal('NG'), consentVersion: z.literal('professional-registration-v1'),
}).strict().superRefine((data, ctx) => {
  if (!professionDefinition(data.professionType)?.disciplines.includes(data.discipline)) ctx.addIssue({ code: 'custom', path: ['discipline'], message: 'Choose a discipline for this profession.' });
  if (needsCurrentLicence(data)) {
    if (!data.registrationNumber || data.licenceType !== 'annual') ctx.addIssue({ code: 'custom', path: ['registrationNumber'], message: 'Regulator registration and current dated licence details are required.' });
    if (data.licenceType === 'annual' && (!/^\d{4}-\d{2}-\d{2}$/.test(data.licenceExpiry || '') || !Number.isFinite(new Date(`${data.licenceExpiry}T00:00:00Z`).getTime()) || new Date(`${data.licenceExpiry}T00:00:00Z`).toISOString().slice(0, 10) !== data.licenceExpiry || new Date(`${data.licenceExpiry}T23:59:59.999Z`) < new Date())) ctx.addIssue({ code: 'custom', path: ['licenceExpiry'], message: 'A valid current licence expiry is required.' });
  }
}) });
