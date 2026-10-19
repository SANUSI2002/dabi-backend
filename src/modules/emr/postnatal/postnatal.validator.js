import { z } from 'zod';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const prose = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');

// Maternal and newborn danger signs (the Postnatal screen's checklist).
export const DANGER_SIGNS = ['Not feeding well', 'Convulsions', 'Fast breathing (>60/min)', 'Severe chest indrawing', 'Hypothermia (<35.5°)', 'Fever (>37.5°)', 'Jaundice', 'Umbilical infection'];

export const list = z.object({
  params: z.object(org).strict(),
  query: z.object({ patientId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(100), cursor: z.string().max(200).optional() }).strict(),
});
export const due = z.object({ params: z.object(org).strict(), query: noQuery });

export const record = z.object({
  params: z.object(org).strict(),
  query: noQuery,
  body: z.object({
    patientId: z.uuid(),
    deliveryId: z.uuid().optional(),
    visitDate: z.iso.date(),
    daysPostpartum: z.number().int().min(0).max(60).optional(),
    systolic: z.number().int().min(50).max(260).optional(),
    diastolic: z.number().int().min(30).max(180).optional(),
    uterus: z.enum(['WELL_CONTRACTED', 'POORLY_CONTRACTED', 'TENDER']),
    lochia: z.enum(['NORMAL', 'EXCESSIVE', 'OFFENSIVE']),
    breast: z.enum(['NORMAL', 'ENGORGED', 'CRACKED_NIPPLE', 'MASTITIS']),
    breastfeeding: z.enum(['EXCLUSIVE', 'MIXED', 'NOT_BREASTFEEDING']),
    dangerSigns: z.array(z.enum(DANGER_SIGNS)).refine((list) => new Set(list).size === list.length, 'Each sign once').default([]),
    fpCounselled: z.boolean().default(false),
    notes: prose(1000).optional(),
  }).strict()
    .refine((b) => (b.systolic === undefined) === (b.diastolic === undefined), { path: ['diastolic'], message: 'Give both systolic and diastolic pressure.' })
    .refine((b) => b.systolic === undefined || b.diastolic < b.systolic, { path: ['diastolic'], message: 'Diastolic must be lower than systolic.' }),
});

export const enteredInError = z.object({
  params: z.object({ ...org, visitId: z.uuid() }).strict(),
  query: noQuery,
  body: z.object({ reason: z.string().trim().min(3).max(300).regex(/^[^\p{Cc}]+$/u, 'Contains control characters') }).strict(),
});
