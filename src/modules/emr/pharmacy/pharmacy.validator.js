import { z } from 'zod';
import { ADJUSTMENT_REASONS, FREQUENCIES } from './pharmacy.policy.js';
import { ROUTES, formularyCode, formularyFields } from './formulary.catalog.js';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');
const reason = z.string().trim().min(3).max(500).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');
const date = z.iso.date();
const uniqueBy = (key) => (list) => new Set(list.map((entry) => entry[key])).size === list.length;
const cursorQuery = { limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(200).optional() };

// ---- formulary ----
export const listFormulary = z.object({
  params: z.object(org).strict(),
  query: z.object({ includeInactive: z.enum(['true', 'false']).optional(), q: z.string().trim().max(60).optional() }).strict(),
});
export const createFormulary = z.object({
  params: z.object(org).strict(), query: noQuery,
  body: z.object({ code: formularyCode, ...formularyFields }).strict(),
});
export const updateFormulary = z.object({
  params: z.object({ ...org, code: formularyCode }).strict(), query: noQuery,
  body: z.object({ ...Object.fromEntries(Object.entries(formularyFields).map(([k, v]) => [k, v.optional()])), active: z.boolean().optional() })
    .strict().refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change'),
});

// ---- stock ----
export const stockLevels = z.object({
  params: z.object(org).strict(),
  query: z.object({
    q: z.string().trim().max(60).optional(),
    lowOnly: z.enum(['true', 'false']).optional(),
    expiringWithinDays: z.coerce.number().int().min(1).max(730).optional(),
  }).strict(),
});
export const receive = z.object({
  params: z.object(org).strict(), query: noQuery,
  body: z.object({
    formularyCode,
    batchNumber: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9./_-]+$/, 'Batch numbers are letters, digits and . / _ -'),
    expiryDate: date,
    quantity: z.number().int().min(1).max(1_000_000),
    unitCostMinor: z.number().int().min(0).max(1e10).optional(),
    supplier: text(120).optional(),
  }).strict(),
});
export const adjust = z.object({
  params: z.object({ ...org, batchId: z.uuid() }).strict(), query: noQuery,
  body: z.object({
    quantity: z.number().int().min(-1_000_000).max(1_000_000).refine((q) => q !== 0, 'Must not be zero'),
    reason: z.enum(ADJUSTMENT_REASONS),
    note: text(300).optional(),
  }).strict().refine((b) => b.reason !== 'OTHER' || b.note, { message: 'A note is required when the reason is OTHER', path: ['note'] }),
});
export const movements = z.object({
  params: z.object(org).strict(),
  query: z.object({ formularyCode: formularyCode.optional(), batchId: z.uuid().optional(), ...cursorQuery }).strict(),
});
export const orgOnly = z.object({ params: z.object(org).strict(), query: noQuery });

// ---- allergies ----
const patientParams = { ...org, patientId: z.uuid() };
export const listAllergies = z.object({ params: z.object(patientParams).strict(), query: z.object({ includeErrors: z.enum(['true', 'false']).optional() }).strict() });
export const recordAllergy = z.object({
  params: z.object(patientParams).strict(), query: noQuery,
  body: z.object({
    substance: text(120),
    // A formulary code (e.g. AMOX500) or a drug class (e.g. PENICILLIN) — what the checks match on.
    substanceCode: formularyCode,
    reaction: text(200).optional(),
    severity: z.enum(['MILD', 'MODERATE', 'SEVERE']).default('MODERATE'),
  }).strict(),
});
export const markAllergy = z.object({ params: z.object({ ...patientParams, allergyId: z.uuid() }).strict(), query: noQuery, body: z.object({ reason }).strict() });
export const medications = z.object({ params: z.object(patientParams).strict(), query: z.object({ scope: z.enum(['current', 'all']).default('current') }).strict() });

// ---- prescribing ----
const line = z.object({
  drugCode: formularyCode,
  dose: z.number().positive().max(1e6),
  doseUnit: z.string().trim().min(1).max(20),
  frequency: z.enum(Object.keys(FREQUENCIES)),
  route: z.enum(ROUTES).optional(),
  durationDays: z.number().int().min(1).max(365).optional(),
  quantity: z.number().int().min(1).max(10_000).optional(),
  prn: z.boolean().optional(),
  prnReason: text(200).optional(),
  instructions: text(500).optional(),
}).strict();
const override = z.object({ drugCode: formularyCode, type: z.enum(['ALLERGY', 'MAX_DOSE', 'DUPLICATE_THERAPY']), reason }).strict();

const encounterParams = { ...org, encounterId: z.uuid() };
export const prescribe = z.object({
  params: z.object(encounterParams).strict(), query: noQuery,
  body: z.object({
    items: z.array(line).min(1).max(20).refine(uniqueBy('drugCode'), 'Each drug can appear once per prescription'),
    notes: text(1000).optional(),
    overrides: z.array(override).max(60).optional(),
  }).strict(),
});
export const encounterPrescriptions = z.object({ params: z.object(encounterParams).strict(), query: noQuery });
export const cancelPrescription = z.object({ params: z.object({ ...encounterParams, prescriptionId: z.uuid() }).strict(), query: noQuery, body: z.object({ reason }).strict() });

// ---- pharmacy ----
const prescriptionParams = z.object({ ...org, prescriptionId: z.uuid() }).strict();
export const queue = z.object({
  params: z.object(org).strict(),
  query: z.object({
    status: z.string().optional().transform((value) => (value ? value.split(',') : undefined))
      .pipe(z.array(z.enum(['PENDING_REVIEW', 'APPROVED', 'PARTIALLY_DISPENSED', 'DISPENSED', 'REJECTED', 'CANCELLED'])).max(6).optional()),
    patientId: z.uuid().optional(),
    ...cursorQuery,
  }).strict(),
});
export const onePrescription = z.object({ params: prescriptionParams, query: noQuery });
export const approve = z.object({ params: prescriptionParams, query: noQuery, body: z.object({ note: text(500).optional() }).strict() });
export const reject = z.object({ params: prescriptionParams, query: noQuery, body: z.object({ reason }).strict() });
export const dispense = z.object({
  params: prescriptionParams, query: noQuery,
  body: z.object({
    lines: z.array(z.object({ itemId: z.uuid(), quantity: z.number().int().min(1).max(10_000) }).strict()).min(1).max(20).refine(uniqueBy('itemId'), 'Each item can appear once'),
    witnessUserId: z.uuid().optional(),
    note: text(500).optional(),
  }).strict(),
});
export const returnDispense = z.object({
  params: z.object({ ...org, dispenseId: z.uuid() }).strict(), query: noQuery,
  body: z.object({
    lines: z.array(z.object({ lineId: z.uuid(), quantity: z.number().int().min(1).max(10_000) }).strict()).min(1).max(40).refine(uniqueBy('lineId'), 'Each line can appear once'),
    reason,
    restock: z.boolean(),
  }).strict(),
});
