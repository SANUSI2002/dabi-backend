import { z } from 'zod';

const plain = (max) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}\p{Cf}]+$/u, 'Contains control characters');
const name = plain(80);
const optional = (schema) => schema.nullable().optional();
const today = () => new Date().toISOString().slice(0, 10);

export const birthDate = z.iso.date().refine((value) => value >= '1850-01-01' && value <= today(), 'Date of birth is out of range');
export const mrn = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{2,31}$/, 'MRN must be 3-32 letters, digits or dashes');
const phone = z.string().trim().regex(/^\+?[0-9][0-9 -]{6,19}$/, 'Phone number is not valid');
const nationalId = z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{5,32}$/, 'National ID is not valid');
const sex = z.enum(['FEMALE', 'MALE', 'OTHER', 'UNKNOWN']);

const demographics = {
  otherNames: optional(name),
  phone: optional(phone),
  email: optional(z.email().max(254)),
  address: optional(plain(300)),
  state: optional(plain(60)),
  lga: optional(plain(80)),
  nationalId: optional(nationalId),
  nextOfKinName: optional(plain(120)),
  nextOfKinPhone: optional(phone),
  nextOfKinRelationship: optional(plain(40)),
  consentToContact: optional(z.boolean()),
};

export const organizationParams = z.object({ organizationId: z.uuid() });
const patientParams = z.object({ organizationId: z.uuid(), patientId: z.uuid() }).strict();
const noQuery = z.object({}).strict();

export const createPatient = z.object({
  params: organizationParams.strict(),
  query: noQuery,
  body: z.object({ givenName: name, familyName: name, dateOfBirth: birthDate, sex: sex.default('UNKNOWN'), medicalRecordNumber: mrn, ...demographics }).strict(),
});

export const listPatients = z.object({
  params: organizationParams.strict(),
  query: z.object({
    q: z.string().trim().max(50).optional(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ACTIVE'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(200).optional(),
    // Legacy offset paging (Command Center registry page). Capped so it cannot become a deep scan.
    page: z.coerce.number().int().min(1).max(100).optional(),
  }).strict().refine((query) => !(query.cursor && query.page), 'Use either cursor or page, not both'),
});

export const getPatient = z.object({ params: patientParams, query: noQuery });

export const updatePatient = z.object({
  params: patientParams,
  query: noQuery,
  body: z.object({ givenName: name.optional(), familyName: name.optional(), dateOfBirth: birthDate.optional(), sex: sex.optional(), ...demographics })
    .strict()
    .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change'),
});

export const deactivatePatient = z.object({ params: patientParams, query: noQuery, body: z.object({ reason: plain(200).min(3) }).strict() });
export const reactivatePatient = z.object({ params: patientParams, query: noQuery, body: z.object({}).strict() });
export const linkAccount = z.object({ params: patientParams, query: noQuery, body: z.object({ userId: z.uuid() }).strict() });

export const duplicateCheck = z.object({
  params: organizationParams.strict(),
  query: z.object({
    givenName: name.optional(),
    familyName: name.optional(),
    dateOfBirth: birthDate.optional(),
    nationalId: nationalId.optional(),
    phone: phone.optional(),
  }).strict().refine((query) => query.nationalId || query.phone || (query.familyName && query.dateOfBirth), 'Send nationalId, phone, or familyName with dateOfBirth'),
});
