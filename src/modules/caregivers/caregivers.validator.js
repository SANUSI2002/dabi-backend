import { z } from 'zod';

const required = (max) => z.string().trim().min(1, 'Required').max(max);
export const caregiverTypes = ['Parent', 'Guardian', 'Spouse', 'Child', 'Sibling', 'Relative', 'Professional caregiver', 'Legal representative', 'Other'];
export const countries = ['Nigeria', 'Ghana', 'Kenya', 'South Africa', 'United Kingdom', 'United States', 'Other'];
const password = z.string().min(8).max(128).regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/).regex(/[^A-Za-z0-9]/);
export const registrationBody = z.object({
  account: z.object({
    firstName: required(100), lastName: required(100),
    email: required(320).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email address').transform((s) => s.toLowerCase()),
    phone: required(50), dateOfBirth: z.string().date(),
    country: z.enum(countries), state: required(120), city: required(120),
    password, confirmPassword: z.string().max(128),
  }).strict().refine((a) => a.password === a.confirmPassword, { path: ['confirmPassword'], message: "Passwords don't match" }),
  caregiverType: z.enum(caregiverTypes),
  connection: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('invite'), relationship: required(200), inviteContact: required(320) }).strict(),
    z.object({ mode: z.literal('connect'), relationship: required(200), patientReference: required(320) }).strict(),
  ]),
  consent: z.object({ terms: z.literal(true), privacy: z.literal(true) }).strict(),
}).strict();
export const registration = z.object({ body: registrationBody, query: z.object({}).strict() });
export const me = z.object({ query: z.object({}).strict() });
