import { z } from 'zod';

const org = { organizationId: z.uuid() };
const one = { ...org, pregnancyId: z.uuid() };
const noQuery = z.object({}).strict();
const prose = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const STATUSES = ['ACTIVE', 'DELIVERED', 'TRANSFERRED_OUT', 'ENDED'];
const hb = z.number().min(2).max(25).multipleOf(0.1);

export const list = z.object({
  params: z.object(org).strict(),
  query: z.object({
    status: z.string().transform((value) => value.split(',')).pipe(z.array(z.enum(STATUSES)).min(1)).optional(),
    patientId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    cursor: z.string().max(200).optional(),
  }).strict(),
});

export const enrol = z.object({
  params: z.object(org).strict(),
  query: noQuery,
  body: z.object({
    patientId: z.uuid(),
    lmp: z.iso.date(),
    gravida: z.number().int().min(1).max(20),
    parity: z.number().int().min(0).max(19),
    bloodGroup: z.enum(['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-']).optional(),
    bookingHb: hb.optional(),
    ttDoses: z.number().int().min(0).max(5).default(0),
  }).strict().refine((body) => body.parity < body.gravida, { path: ['parity'], message: 'Parity must be less than gravida (gravida counts this pregnancy).' }),
});

export const visit = z.object({
  params: z.object(one).strict(),
  query: noQuery,
  body: z.object({
    visitDate: z.iso.date(),
    weightKg: z.number().min(25).max(250).multipleOf(0.1).optional(),
    systolic: z.number().int().min(50).max(260).optional(),
    diastolic: z.number().int().min(30).max(180).optional(),
    hb: hb.optional(),
    fetalHeartRate: z.number().int().min(60).max(240).optional(),
    nextVisitDate: z.iso.date().optional(),
    notes: prose(1000).optional(),
  }).strict()
    .refine((b) => (b.systolic === undefined) === (b.diastolic === undefined), { path: ['diastolic'], message: 'Give both systolic and diastolic pressure.' })
    .refine((b) => b.systolic === undefined || b.diastolic < b.systolic, { path: ['diastolic'], message: 'Diastolic must be lower than systolic.' })
    .refine((b) => !b.nextVisitDate || b.nextVisitDate > b.visitDate, { path: ['nextVisitDate'], message: 'The next visit must be after this visit.' }),
});

export const enteredInError = z.object({
  params: z.object({ ...one, visitId: z.uuid() }).strict(),
  query: noQuery,
  body: z.object({ reason: z.string().trim().min(3).max(300).regex(/^[^\p{Cc}]+$/u, 'Contains control characters') }).strict(),
});

export const close = z.object({
  params: z.object(one).strict(),
  query: noQuery,
  body: z.object({
    status: z.enum(['DELIVERED', 'TRANSFERRED_OUT', 'ENDED']),
    note: z.string().trim().min(3).max(300).regex(/^[^\p{Cc}]+$/u, 'Contains control characters').optional(),
  }).strict().refine((b) => b.status === 'DELIVERED' || !!b.note, { path: ['note'], message: 'Say where she transferred to, or why the pregnancy ended.' }),
});
