import { z } from 'zod';
import { VITALS } from './encounters.policy.js';

const text = (max) => z.string().trim().min(1).max(max);
const reason = z.string().trim().min(3).max(500).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');
const noteText = z.string().max(20_000).nullable().optional();
const org = { organizationId: z.uuid() };
const enc = { ...org, encounterId: z.uuid() };
const noQuery = z.object({}).strict();
const noBody = z.object({}).strict();
const encounterClass = z.enum(['OUTPATIENT', 'INPATIENT', 'EMERGENCY', 'TELEHEALTH']);
const noteKind = z.enum(['CONSULTATION', 'PROGRESS', 'NURSING', 'PROCEDURE', 'DISCHARGE']);
// ICD-10: letter, two digits, optional dot and up to four more characters (e.g. J45, J45.901).
const icd10 = z.string().trim().toUpperCase().regex(/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/, 'Must be an ICD-10 code such as J45 or J45.901');

export const listEncounters = z.object({
  params: z.object(org).strict(),
  query: z.object({
    status: z.string().optional().transform((value) => (value ? value.split(',') : undefined))
      .pipe(z.array(z.enum(['ARRIVED', 'IN_PROGRESS', 'FINISHED', 'CANCELLED'])).max(4).optional()),
    patientId: z.uuid().optional(),
    class: encounterClass.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(200).optional(),
  }).strict(),
});

export const openEncounter = z.object({
  params: z.object(org).strict(),
  query: noQuery,
  body: z.object({
    patientId: z.uuid(),
    class: encounterClass.default('OUTPATIENT'),
    reason: text(500).optional(),
    attendingUserId: z.uuid().optional(),
  }).strict(),
});

export const oneEncounter = z.object({ params: z.object(enc).strict(), query: noQuery });

export const updateEncounter = z.object({
  params: z.object(enc).strict(),
  query: noQuery,
  body: z.object({ reason: text(500).nullable().optional(), attendingUserId: z.uuid().nullable().optional(), class: encounterClass.optional() })
    .strict().refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change'),
});

export const transition = z.object({ params: z.object(enc).strict(), query: noQuery, body: noBody });
export const cancelEncounter = z.object({ params: z.object(enc).strict(), query: noQuery, body: z.object({ reason }).strict() });

// ---- notes ----
const noteContent = { subjective: noteText, objective: noteText, assessment: noteText, plan: noteText, body: noteText };
export const createNote = z.object({ params: z.object(enc).strict(), query: noQuery, body: z.object({ kind: noteKind, ...noteContent }).strict() });
const noteParams = z.object({ ...enc, noteId: z.uuid() }).strict();
export const updateNote = z.object({
  params: noteParams, query: noQuery,
  body: z.object(noteContent).strict().refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change'),
});
export const signNote = z.object({ params: noteParams, query: noQuery, body: noBody });
export const amendNote = z.object({ params: noteParams, query: noQuery, body: z.object({ reason, body: z.string().trim().min(1).max(20_000) }).strict() });

// ---- vitals ----
export const recordVitals = z.object({
  params: z.object(enc).strict(),
  query: noQuery,
  body: z.object({
    recordedAt: z.iso.datetime({ offset: true }).optional(),
    readings: z.array(z.object({ code: z.enum(Object.keys(VITALS)), value: z.number().finite() }).strict()).min(1).max(Object.keys(VITALS).length),
  }).strict(),
});
export const markObservation = z.object({ params: z.object({ ...enc, observationId: z.uuid() }).strict(), query: noQuery, body: z.object({ reason }).strict() });

// ---- diagnoses ----
export const recordDiagnosis = z.object({
  params: z.object(enc).strict(),
  query: noQuery,
  body: z.object({ code: icd10, description: text(300), rank: z.enum(['PRIMARY', 'SECONDARY']).default('SECONDARY') }).strict(),
});
export const markDiagnosis = z.object({ params: z.object({ ...enc, diagnosisId: z.uuid() }).strict(), query: noQuery, body: z.object({ reason }).strict() });
