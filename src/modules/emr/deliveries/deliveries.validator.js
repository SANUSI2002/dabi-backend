import { z } from 'zod';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');
const prose = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const page = { limit: z.coerce.number().int().min(1).max(200).default(100), cursor: z.string().max(200).optional() };

// NHMIS delivery and newborn-care indicators (the Labour screen's checklists).
export const NHMIS_INDICATORS = [
  'Decision-to-seek-care ≤ 24 hours', 'Arrived by ambulance / referral', 'Labour monitored with partograph',
  'Delivery by Skilled Birth Attendant (SBA)', 'Uterotonic given in 3rd stage',
  'Cord clamped / cut after 1 minute', 'Chlorhexidine applied to cord', 'Skin-to-skin within 1 hour',
  'Early initiation of breastfeeding (< 1 hr)', 'Newborn temperature taken at 1 hour',
];

export const listDeliveries = z.object({ params: z.object(org).strict(), query: z.object({ patientId: z.uuid().optional(), ...page }).strict() });

const apgar = z.number().int().min(0).max(10);
export const recordDelivery = z.object({
  params: z.object(org).strict(),
  query: noQuery,
  body: z.object({
    patientId: z.uuid(),
    bookingStatus: z.enum(['BOOKED', 'UNBOOKED', 'REFERRED_IN']),
    deliveredAt: z.iso.datetime({ offset: true }),
    gestationalWeeks: z.number().int().min(20).max(45).optional(),
    mode: z.enum(['SVD', 'ASSISTED_VACUUM', 'BREECH', 'CAESAREAN_REFERRED']),
    motherStatus: z.enum(['ALIVE', 'DIED', 'REFERRED']),
    bloodLossMl: z.number().int().min(0).max(6000),
    complications: text(500).optional(),
    notes: prose(1000).optional(),
    nhmisIndicators: z.array(z.enum(NHMIS_INDICATORS)).max(NHMIS_INDICATORS.length).refine((list) => new Set(list).size === list.length, 'Each indicator once').default([]),
    babySex: z.enum(['FEMALE', 'MALE']),
    babyStatus: z.enum(['ALIVE', 'FRESH_STILLBIRTH', 'MACERATED_STILLBIRTH']),
    birthWeightKg: z.number().min(0.3).max(7).multipleOf(0.01),
    apgar1: apgar.optional(),
    apgar5: apgar.optional(),
    breastfedWithinHour: z.boolean().default(false),
    conductedByUserId: z.uuid(),
  }).strict()
    .refine((b) => b.babyStatus !== 'ALIVE' || (b.apgar1 !== undefined && b.apgar5 !== undefined), { path: ['apgar5'], message: 'Give both APGAR scores for a live baby.' })
    .refine((b) => b.babyStatus === 'ALIVE' || (b.apgar1 === undefined && b.apgar5 === undefined && !b.breastfedWithinHour), { path: ['babyStatus'], message: 'A stillborn baby has no APGAR scores and was not breastfed.' }),
});

const reason = z.object({ reason: z.string().trim().min(3).max(300).regex(/^[^\p{Cc}]+$/u, 'Contains control characters') }).strict();
export const deliveryError = z.object({ params: z.object({ ...org, deliveryId: z.uuid() }).strict(), query: noQuery, body: reason });

export const listRegister = z.object({
  params: z.object(org).strict(),
  query: z.object({ status: z.string().transform((v) => v.split(',')).pipe(z.array(z.enum(['NOTIFIED', 'REGISTERED', 'CERTIFICATE_ISSUED'])).min(1)).optional(), ...page }).strict(),
});
export const notify = z.object({
  params: z.object({ ...org, deliveryId: z.uuid() }).strict(),
  query: noQuery,
  body: z.object({
    babyName: text(160).optional(),
    fatherName: text(160).optional(),
    informantName: text(160),
    informantRelation: z.enum(['MOTHER', 'FATHER', 'GRANDPARENT', 'GUARDIAN', 'HEALTH_WORKER']),
  }).strict(),
});
const oneRegistration = z.object({ ...org, registrationId: z.uuid() }).strict();
export const register = z.object({
  params: oneRegistration,
  query: noQuery,
  body: z.object({ registrationNumber: z.string().trim().min(3).max(60).regex(/^[A-Za-z0-9/ -]+$/, 'Letters, numbers, spaces, / and - only'), babyName: text(160).optional() }).strict(),
});
export const certificate = z.object({ params: oneRegistration, query: noQuery, body: z.object({}).strict() });
