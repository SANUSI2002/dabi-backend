import { z } from 'zod';
export const PERMISSIONS = ['PROFILE', 'RECORDS', 'APPOINTMENTS', 'MEDICATIONS', 'VITALS', 'EMERGENCY_SUMMARY'];
const uuid = z.string().uuid(); const permissions = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).transform((items) => [...new Set(items)]);
export const listSchema = z.object({ query: z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), status: z.enum(['PENDING', 'ACTIVE', 'DECLINED', 'REVOKED', 'EXPIRED']).optional() }).strict() });
export const inviteSchema = z.object({ body: z.object({ email: z.string().trim().email().transform((email) => email.toLowerCase()), relationshipType: z.enum(['CAREGIVER', 'DEPENDENT']), permissions, expiresAt: z.string().datetime({ offset: true }).optional() }).strict() }).superRefine(({ body }, ctx) => { if (body.expiresAt && new Date(body.expiresAt) <= new Date()) ctx.addIssue({ code: 'custom', path: ['body', 'expiresAt'], message: 'expiresAt must be in the future' }); });
export const relationshipId = z.object({ params: z.object({ id: uuid }).strict() });
export const permissionsSchema = z.object({ params: z.object({ id: uuid }).strict(), body: z.object({ permissions }).strict() });
export const tokenSchema = z.object({ body: z.object({ token: z.string().min(32).max(512) }).strict() });
export const accessSchema = z.object({ params: z.object({ patientId: uuid }).strict() });


const emptyQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max);
export const levels = ['owner', 'care-manager', 'caregiver', 'viewer', 'emergency-only'];
export const relationships = ['Spouse', 'Mother', 'Father', 'Son', 'Daughter', 'Sister', 'Brother', 'Grandparent', 'Guardian', 'Other'];
const permissionLevel = z.enum(levels);
const token = z.string().regex(/^[a-f0-9]{64}$/, 'Invalid invite code');
const params = z.object({ id: uuid }).strict();
export const circleSchema = z.object({ query: emptyQuery });
export const memberSchema = z.object({ params, query: emptyQuery });
export const addMemberSchema = z.object({ query: emptyQuery, body: z.discriminatedUnion('method', [
  z.object({ method: z.literal('email'), email: z.string().trim().email().max(320).toLowerCase(), permissions, permissionLevel }).strict(),
  z.object({ method: z.literal('patientId'), patientReference: text(100), relationship: z.enum(relationships), permissions, permissionLevel }).strict(),
]) });
export const linkSchema = z.object({ query: emptyQuery, body: z.object({ permissionLevel }).strict() });
export const lookupSchema = z.object({ query: emptyQuery, body: z.object({ token }).strict() });
export const joinSchema = z.object({ query: emptyQuery, body: z.object({ token, permissionLevel, requestedPermissions: permissions }).strict() });
export const approveSchema = z.object({ params, query: emptyQuery, body: z.object({ permissions }).strict() });
const optionalText = (max) => text(max).nullable().optional();
const listText = z.array(text(120)).max(50);
const dependentFields = {
  fullName: text(160), nickname: optionalText(100), dateOfBirth: z.string().date().nullable().optional(),
  gender: z.enum(['Male', 'Female']).nullable().optional(),
  bloodGroup: z.enum(['A+', 'A-', 'B+', 'B-', 'O+']).nullable().optional(),
  genotype: z.enum(['AA', 'AS', 'SS', 'AC', 'SC']).nullable().optional(),
  allergies: listText.optional(), conditions: listText.optional(), careType: z.enum(['Child', 'Elderly']).nullable().optional(),
  immunizationStatus: z.enum(['Up to date', 'Partially complete', 'Not started']).nullable().optional(),
  milestones: z.array(z.enum(['Smiling & Cooing', 'Rolling Over', 'Sitting Unassisted', 'Independent Mobility', 'Uses Walking Aid', 'Fall Risk Assessment Done'])).max(6).optional(),
  weightKg: z.number().finite().positive().max(1000).nullable().optional(),
  heightCm: z.number().finite().positive().max(400).nullable().optional(),
  primaryPhysician: optionalText(200), insuranceProvider: optionalText(200), policyNumber: optionalText(100),
  coManagerIds: z.array(uuid).max(30).refine((ids) => new Set(ids).size === ids.length, 'Duplicate co-manager').optional(),
};
export const createDependentSchema = z.object({ query: emptyQuery, body: z.object(dependentFields).strict() });
export const updateDependentSchema = z.object({ params, query: emptyQuery, body: z.object(dependentFields).partial().strict().refine((data) => Object.keys(data).length > 0, 'No changes supplied') });
