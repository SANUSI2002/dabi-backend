import { z } from 'zod';
import { ROUTES } from '../pharmacy/formulary.catalog.js';
import { BED_STATUSES, DISPOSITIONS, GENDER_RESTRICTIONS, WARD_KINDS } from './admissions.policy.js';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');
const reason = z.string().trim().min(3).max(500).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,15}$/, 'Codes are 1-16 letters, digits, _ or -');
const bedCodes = z.array(code).min(1).max(200).refine((codes) => new Set(codes).size === codes.length, 'Bed codes must be unique');
const today = () => new Date().toISOString().slice(0, 10);
const optionalText = (max) => text(max).nullable().optional();
const RISK = z.enum(['Low', 'Moderate', 'High']);
// How the ward describes the stay (not used by any rule; shown on the census and handover).
const stayDetails = {
  admittingDiagnosis: optionalText(300),
  service: optionalText(80),
  isolation: optionalText(120),
};

// ---- wards and beds ----
export const listWards = z.object({ params: z.object(org).strict(), query: z.object({ includeInactive: z.enum(['true', 'false']).optional() }).strict() });
export const createWard = z.object({
  params: z.object(org).strict(), query: noQuery,
  body: z.object({ code, name: text(80), kind: z.enum(WARD_KINDS), genderRestriction: z.enum(GENDER_RESTRICTIONS).default('ANY'), beds: bedCodes.optional() }).strict(),
});
const wardParams = z.object({ ...org, wardId: z.uuid() }).strict();
export const updateWard = z.object({
  params: wardParams, query: noQuery,
  body: z.object({ name: text(80).optional(), kind: z.enum(WARD_KINDS).optional(), genderRestriction: z.enum(GENDER_RESTRICTIONS).optional(), active: z.boolean().optional() })
    .strict().refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change'),
});
export const oneWard = z.object({ params: wardParams, query: noQuery });
export const addBeds = z.object({ params: wardParams, query: noQuery, body: z.object({ codes: bedCodes }).strict() });
export const bedStatus = z.object({
  params: z.object({ ...org, bedId: z.uuid() }).strict(), query: noQuery,
  body: z.object({ status: z.enum(BED_STATUSES.filter((s) => s !== 'OCCUPIED')), reason: text(200).optional() })
    .strict().refine((b) => b.status !== 'OUT_OF_SERVICE' || b.reason, { message: 'A reason is required to take a bed out of service', path: ['reason'] }),
});

// ---- admissions ----
export const admit = z.object({
  params: z.object({ ...org, encounterId: z.uuid() }).strict(), query: noQuery,
  body: z.object({
    bedId: z.uuid(),
    reason: text(500),
    attendingUserId: z.uuid().optional(),
    expectedDischargeDate: z.iso.date().refine((d) => d >= today(), 'Must not be in the past').optional(),
    ...stayDetails,
  }).strict(),
});
export const listAdmissions = z.object({
  params: z.object(org).strict(),
  query: z.object({
    status: z.enum(['ADMITTED', 'DISCHARGED', 'CANCELLED']).optional(),
    wardId: z.uuid().optional(),
    patientId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(200).optional(),
  }).strict(),
});
const admissionParams = z.object({ ...org, admissionId: z.uuid() }).strict();
export const oneAdmission = z.object({ params: admissionParams, query: noQuery });
export const updateAdmission = z.object({
  params: admissionParams, query: noQuery,
  body: z.object({
    ...stayDetails,
    dischargeReady: z.boolean().optional(),
    attendingUserId: z.uuid().nullable().optional(),
    expectedDischargeDate: z.iso.date().refine((d) => d >= today(), 'Must not be in the past').nullable().optional(),
  }).strict().refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change'),
});
export const transfer = z.object({ params: admissionParams, query: noQuery, body: z.object({ bedId: z.uuid(), note: text(300).optional() }).strict() });
export const discharge = z.object({
  params: admissionParams, query: noQuery,
  body: z.object({ disposition: z.enum(DISPOSITIONS), summary: z.string().trim().min(10).max(20_000), destination: optionalText(200) }).strict(),
});
export const cancelAdmission = z.object({ params: admissionParams, query: noQuery, body: z.object({ reason }).strict() });

// ---- nursing flowsheet ----
export const recordNursing = z.object({
  params: admissionParams, query: noQuery,
  body: z.object({
    recordedAt: z.iso.datetime({ offset: true }).optional(),
    fluidIntakeMl: z.number().int().min(0).max(20_000).optional(),
    fluidOutputMl: z.number().int().min(0).max(20_000).optional(),
    mobility: text(60).optional(),
    fallsRisk: RISK.optional(),
    pressureRisk: RISK.optional(),
    note: z.string().trim().min(1).max(2000).optional(),
  }).strict().refine((body) => Object.entries(body).some(([key, value]) => key !== 'recordedAt' && value !== undefined), 'Record at least one finding'),
});

// ---- MAR ----
export const recordAdministration = z.object({
  params: admissionParams, query: noQuery,
  body: z.object({
    prescriptionItemId: z.uuid(),
    status: z.enum(['GIVEN', 'HELD', 'REFUSED', 'MISSED']),
    dose: z.number().positive().max(1e6).optional(),
    doseUnit: z.string().trim().min(1).max(20).optional(),
    route: z.enum(ROUTES).optional(),
    administeredAt: z.iso.datetime({ offset: true }).optional(),
    witnessUserId: z.uuid().optional(),
    reason: text(300).optional(),
  }).strict().superRefine((b, ctx) => {
    if (b.status === 'GIVEN' && (b.dose === undefined || !b.doseUnit)) ctx.addIssue({ code: 'custom', path: ['dose'], message: 'A given dose needs dose and doseUnit' });
    if (b.status !== 'GIVEN' && (b.dose !== undefined || b.doseUnit || b.route)) ctx.addIssue({ code: 'custom', path: ['dose'], message: 'Only a given dose has a dose, unit and route' });
    if (b.status !== 'GIVEN' && !b.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: `A reason is required when a dose is ${b.status.toLowerCase()}` });
  }),
});
export const markAdministration = z.object({
  params: z.object({ ...org, admissionId: z.uuid(), administrationId: z.uuid() }).strict(), query: noQuery,
  body: z.object({ reason }).strict(),
});
