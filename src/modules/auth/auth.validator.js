import { z } from 'zod';

const passwordSchema = z.string().min(8, 'Password must be at least 8 characters').max(128);

export const registerPatientSchema = z.object({
  body: z.object({
    email: z.string().email('A valid email is required').max(320),
    password: passwordSchema,
    firstName: z.string().trim().min(1, 'First name is required').max(100),
    lastName: z.string().trim().min(1, 'Last name is required').max(100),
    phoneNumber: z.string().trim().min(7).max(30).optional(),
    dateOfBirth: z.string().date('Date of birth must be an ISO date').optional(),
    gender: z.string().trim().min(1).max(50).optional(),
    consentGiven: z.literal(true, { message: 'You must accept the Terms and Conditions to register' }),
  }).strict(),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email('A valid email is required').max(320),
    password: z.string().min(1, 'Password is required').max(128),
  }).strict(),
});

export const refreshTokenSchema = z.object({
  body: z.object({ refreshToken: z.string().min(1).max(4096).optional(), organizationId: z.string().uuid().optional() }).strict(),
});
export const sessionIdSchema = z.object({ params: z.object({ id: z.string().uuid() }) });
const factorFields = { code: z.string().regex(/^\d{6}$/).optional(), recoveryCode: z.string().trim().min(20).max(40).optional() };
const oneFactor = (body) => !!body.code !== !!body.recoveryCode;
export const mfaLoginSchema = z.object({ body: z.object({ ...factorFields, challengeToken: z.string().min(32).max(128) }).strict().refine(oneFactor, { message: 'Provide one authenticator or recovery code' }) });
export const mfaFactorSchema = z.object({ body: z.object(factorFields).strict().refine(oneFactor, { message: 'Provide one authenticator or recovery code' }) });
export const mfaEnrollSchema = z.object({ body: z.object({ password: z.string().min(1).max(128) }).strict() });
export const mfaConfirmSchema = z.object({ body: z.object({ code: z.string().regex(/^\d{6}$/) }).strict() });

export const passwordResetRequestSchema = z.object({ body: z.object({ email: z.string().email().max(320) }).strict() });
export const emailVerificationRequestSchema = z.object({ body: z.object({ email: z.string().email().max(320) }).strict() });
export const emailVerificationConfirmSchema = z.object({ body: z.object({ uid: z.string().uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict() });
export const passwordResetConfirmSchema = z.object({ body: z.object({ uid: z.string().uuid(), token: z.string().min(32).max(256), password: passwordSchema.regex(/\d/, 'Password must include a number').regex(/[^A-Za-z0-9]/, 'Password must include a symbol'), confirmPassword: z.string() }).strict().refine((data) => data.password === data.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] }) });
