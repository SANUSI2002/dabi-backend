import { z } from 'zod';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');
const reason = z.string().trim().min(3).max(500).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');
// Minor units (kobo), whole numbers only — never floats. Up to ₦10 billion per line.
const minor = z.number().int().min(0).max(1_000_000_000_000);
const categories = ['CONSULTATION', 'LAB', 'MEDICATION', 'BED_DAY', 'PROCEDURE', 'OTHER'];
const reference = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/, 'References are letters, digits, _ or -');
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code');
const taxRateBp = z.number().int().min(0).max(10_000);
const cursorQuery = { limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(200).optional() };

export const listPrices = z.object({
  params: z.object(org).strict(),
  query: z.object({ category: z.enum(categories).optional(), q: z.string().trim().max(60).optional(), includeInactive: z.enum(['true', 'false']).optional() }).strict(),
});
export const createPrice = z.object({
  params: z.object(org).strict(), query: noQuery,
  body: z.object({ category: z.enum(categories), reference, name: text(120), unitPriceMinor: minor, taxRateBp: taxRateBp.optional(), currency: currency.optional() }).strict(),
});
export const updatePrice = z.object({
  params: z.object({ ...org, priceId: z.uuid() }).strict(), query: noQuery,
  body: z.object({ name: text(120).optional(), unitPriceMinor: minor.optional(), taxRateBp: taxRateBp.optional(), active: z.boolean().optional() })
    .strict().refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change'),
});

const encounterParams = z.object({ ...org, encounterId: z.uuid() }).strict();
export const oneEncounter = z.object({ params: encounterParams, query: noQuery });
export const capture = z.object({ params: encounterParams, query: noQuery, body: z.object({}).strict() });
export const addCharge = z.object({
  params: encounterParams, query: noQuery,
  body: z.object({
    priceItemId: z.uuid().optional(),
    category: z.enum(['PROCEDURE', 'OTHER']).optional(),
    description: text(200).optional(),
    unitPriceMinor: minor.optional(),
    taxRateBp: taxRateBp.optional(),
    currency: currency.optional(),
    quantity: z.number().int().min(1).max(10_000),
  }).strict().superRefine((b, ctx) => {
    if (b.priceItemId && (b.category || b.unitPriceMinor !== undefined || b.taxRateBp !== undefined || b.currency)) {
      ctx.addIssue({ code: 'custom', path: ['priceItemId'], message: 'Use either a price-list item or a hand-priced charge, not both' });
    }
    if (!b.priceItemId && (!b.category || !b.description || b.unitPriceMinor === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['category'], message: 'A hand-priced charge needs category (PROCEDURE or OTHER), description and unitPriceMinor' });
    }
  }),
});
export const voidCharge = z.object({ params: z.object({ ...org, chargeId: z.uuid() }).strict(), query: noQuery, body: z.object({ reason }).strict() });

export const createInvoice = z.object({
  params: encounterParams, query: noQuery,
  body: z.object({
    discountMinor: minor.optional(),
    discountReason: reason.optional(),
    dueDate: z.iso.date().optional(),
  }).strict().refine((b) => !b.discountMinor || b.discountReason, { message: 'A discount needs a reason', path: ['discountReason'] }),
});
export const listInvoices = z.object({
  params: z.object(org).strict(),
  query: z.object({
    status: z.string().optional().transform((value) => (value ? value.split(',') : undefined))
      .pipe(z.array(z.enum(['ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID'])).max(4).optional()),
    patientId: z.uuid().optional(),
    ...cursorQuery,
  }).strict(),
});
const invoiceParams = z.object({ ...org, invoiceId: z.uuid() }).strict();
export const oneInvoice = z.object({ params: invoiceParams, query: noQuery });
export const voidInvoice = z.object({ params: invoiceParams, query: noQuery, body: z.object({ reason }).strict() });
export const recordPayment = z.object({
  params: invoiceParams, query: noQuery,
  body: z.object({
    amountMinor: minor.refine((v) => v > 0, 'Must be more than zero'),
    method: z.enum(['CASH', 'CARD', 'POS', 'BANK_TRANSFER', 'MOBILE_MONEY', 'CHEQUE']),
    reference: text(80).optional(),
  }).strict().refine((b) => ['CASH'].includes(b.method) || b.reference, { message: 'Non-cash payments need a reference (e.g. the transfer or POS reference)', path: ['reference'] }),
});
export const reversePayment = z.object({ params: z.object({ ...org, paymentId: z.uuid() }).strict(), query: noQuery, body: z.object({ reason }).strict() });
export const statement = z.object({ params: z.object({ ...org, patientId: z.uuid() }).strict(), query: noQuery });
export const orgOnly = z.object({ params: z.object(org).strict(), query: noQuery });
