import { Buffer } from 'node:buffer';
import { z } from 'zod';
const text = (max = 160) => z.string().trim().min(1).max(max);
const email = z.string().trim().email().max(254).toLowerCase();
export const types = ['hospital', 'clinic', 'pharmacy', 'laboratory', 'diagnostic-centre', 'other'];
export const authorities = {
  hospital: ['State Ministry of Health', 'Federal Ministry of Health', 'Other'],
  clinic: ['State Ministry of Health', 'Federal Ministry of Health', 'Other'],
  pharmacy: ['PCN (Pharmacists Council of Nigeria)', 'Other'],
  laboratory: ['MLSCN (Medical Laboratory Science Council of Nigeria)', 'Other'],
  'diagnostic-centre': ['Radiographers Registration Board of Nigeria', 'Other'], other: ['Other'],
};
export const maxFileBytes = 5 * 1024 * 1024;
const document = z.object({
  // Reject control characters in untrusted attachment filenames.
  // eslint-disable-next-line no-control-regex
  name: text(200).regex(/^[^/\\\x00-\x1f]+\.(pdf|jpe?g|png)$/i),
  contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
  // Avoid repetition-heavy regexes on multi-megabyte input; check canonical
  // encoding after decoding below.
  base64: z.string().min(4).max(4 * Math.ceil(maxFileBytes / 3)).refine((value) => !/[^A-Za-z0-9+/=]/.test(value), 'Invalid base64'),
}).strict().superRefine((v, ctx) => {
  const bytes = Buffer.from(v.base64, 'base64');
  const signatures = { 'application/pdf': '255044462d', 'image/jpeg': 'ffd8ff', 'image/png': '89504e470d0a1a0a' };
  const extensions = { 'application/pdf': /\.pdf$/i, 'image/jpeg': /\.jpe?g$/i, 'image/png': /\.png$/i };
  if (bytes.length > maxFileBytes || !bytes.toString('hex', 0, 8).startsWith(signatures[v.contentType]) || !extensions[v.contentType].test(v.name) || bytes.toString('base64') !== v.base64) {
    ctx.addIssue({ code: 'custom', message: 'Use a PDF, JPEG or PNG file up to 5 MiB' });
  }
});
const password = z.string().min(8).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/).regex(/[^A-Za-z0-9]/);
const empty = z.object({}).strict();
const envelope = (body, query = empty, params = empty) => z.object({ body, query, params });
export const registration = envelope(z.object({
  organisationType: z.enum(types),
  organisation: z.object({
    entityName: text(), legalName: text(200),
    country: z.enum(['Nigeria', 'Ghana', 'Kenya', 'South Africa', 'United Kingdom', 'United States', 'Other']),
    state: text(100), city: text(100), address: text(500), phone: text(40), email,
    website: z.union([z.literal(''), z.url().max(500).refine((v) => /^https?:\/\//i.test(v))]).optional(),
  }).strict(),
  representative: z.object({ firstName: text(80), lastName: text(80), phone: text(40), email, position: text(120), password, confirmPassword: z.string().max(128) }).strict(),
  regulatory: z.object({ registrationNumber: text(160), regulatoryAuthority: text(120) }).strict(),
  documents: z.object({ businessRegistration: document, representativeId: document, facilityLicense: document.optional(), pharmacyLicense: document.optional() }).strict(),
  services: z.array(z.enum(['General medicine', 'Emergency', 'Surgery', 'Paediatrics', 'Maternity', 'Laboratory', 'Pharmacy', 'Radiology', 'Dental', 'Mental health', 'Other'])).max(11).refine((v) => new Set(v).size === v.length).optional(),
  operatingInfo: z.object({ openingHours: z.enum(['', '8:00 AM \u2013 6:00 PM', '8:00 AM \u2013 8:00 PM', '24 hours', 'Custom (set later)']).optional(), delivery: z.boolean().optional(), pickup: z.boolean().optional() }).strict().optional(),
  consent: z.object({ terms: z.literal(true), privacy: z.literal(true), healthData: z.boolean().optional() }).strict(),
}).strict().superRefine((v, ctx) => {
  const issue = (path, message) => ctx.addIssue({ code: 'custom', path, message });
  if (v.representative.password !== v.representative.confirmPassword) issue(['representative', 'confirmPassword'], "Passwords don't match");
  if (!authorities[v.organisationType].includes(v.regulatory.regulatoryAuthority)) issue(['regulatory', 'regulatoryAuthority'], 'Select a regulatory authority for this organisation type');
  const pharmacy = v.organisationType === 'pharmacy';
  if (pharmacy && !v.documents.pharmacyLicense) issue(['documents', 'pharmacyLicense'], 'This document is required');
  if (!pharmacy && v.organisationType !== 'other' && !v.documents.facilityLicense) issue(['documents', 'facilityLicense'], 'This document is required');
  if (pharmacy && v.documents.facilityLicense || !pharmacy && v.documents.pharmacyLicense) issue(['documents'], 'Document does not apply to this organisation type');
  if (v.organisationType !== 'hospital' && v.services !== undefined) issue(['services'], 'Services apply only to Hospital');
  if (!pharmacy && (v.operatingInfo !== undefined || v.organisation.website !== undefined)) issue(['organisation'], 'Website and operating information apply only to Pharmacy');
}));
const pagination = { page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) };
const status = z.enum(['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED']);
const nonPharmacyType = z.enum(types.filter((v) => v !== 'pharmacy'));
const id = z.object({ id: z.uuid() }).strict();
export const mine = envelope(empty.optional());
export const detail = envelope(empty.optional(), empty, id);
export const publicList = envelope(empty.optional(), z.object({ ...pagination, type: nonPharmacyType.optional(), search: text(100).optional() }).strict());
export const queue = envelope(empty.optional(), z.object({ ...pagination, type: nonPharmacyType.optional(), status: status.default('PENDING') }).strict());
export const decision = envelope(z.object({ note: text(500).optional() }).strict(), empty, id);
export const download = envelope(empty.optional(), empty, z.object({ id: z.uuid(), key: z.enum(['businessRegistration', 'representativeId', 'facilityLicense', 'pharmacyLicense']) }).strict());
