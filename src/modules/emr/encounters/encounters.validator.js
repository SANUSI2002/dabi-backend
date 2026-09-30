import { z } from 'zod';
import { VITALS } from './encounters.policy.js';
import { QUEUE_PRIORITIES, QUEUE_STATIONS } from '../queue/queue.constants.js';

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
const ICD10 = /^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/;
// ICD-11 stem codes: four characters (a letter always second, a digit third; I and O are never
// used), optional dot and one or two more (e.g. 1F40, BA00, CA40.0).
const ICD11 = /^[0-9A-HJ-NP-Z][A-HJ-NP-Z][0-9][0-9A-HJ-NP-Z](\.[0-9A-HJ-NP-Z]{1,2})?$/;
const indicator = z.string().trim().min(1).max(120).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');
const EXAM_SYSTEMS = ['general', 'cardiovascular', 'respiratory', 'abdominal', 'neurological', 'musculoskeletal', 'headAndNeck', 'skin', 'peripheralVascular', 'genitourinary', 'other'];
// Structured physical examination: one entry per examined system, findings exactly as entered.
const examination = z.array(z.object({
  system: z.enum(EXAM_SYSTEMS),
  status: z.enum(['Normal', 'Abnormal']),
  findings: z.record(z.string().trim().min(1).max(60), z.string().trim().max(500)).refine((f) => Object.keys(f).length <= 30, 'At most 30 findings per system').optional(),
  laterality: z.enum(['Left', 'Right', 'Bilateral', 'N/A']).optional(),
  notes: z.string().trim().max(1000).optional(),
  consentDocumented: z.boolean().optional(),
  chaperoneDocumented: z.boolean().optional(),
}).strict()).max(EXAM_SYSTEMS.length).refine((systems) => new Set(systems.map((s) => s.system)).size === systems.length, 'Each system can appear once')
  .nullable().optional();

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
    // Check-in places the patient in the station queue (Vitals by default).
    station: z.enum(QUEUE_STATIONS).default('Vital'),
    priority: z.enum(QUEUE_PRIORITIES).default('NORMAL'),
  }).strict(),
});

export const oneEncounter = z.object({ params: z.object(enc).strict(), query: noQuery });

export const updateEncounter = z.object({
  params: z.object(enc).strict(),
  query: noQuery,
  body: z.object({
    reason: text(500).nullable().optional(), attendingUserId: z.uuid().nullable().optional(), class: encounterClass.optional(),
    visitType: text(80).nullable().optional(),
    nhmisIndicators: z.array(indicator).max(40).refine((items) => new Set(items).size === items.length, 'Each indicator can appear once').optional(),
  })
    .strict().refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change'),
});

export const transition = z.object({ params: z.object(enc).strict(), query: noQuery, body: noBody });
export const cancelEncounter = z.object({ params: z.object(enc).strict(), query: noQuery, body: z.object({ reason }).strict() });

// ---- notes ----
const noteContent = {
  subjective: noteText, objective: noteText, assessment: noteText, plan: noteText, body: noteText,
  examination, followUp: z.string().trim().max(500).nullable().optional(), patientInstructions: z.string().trim().max(1000).nullable().optional(),
};
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
  body: z.object({
    codeSystem: z.enum(['ICD10', 'ICD11']).default('ICD10'),
    code: z.string().trim().toUpperCase(),
    description: text(300),
    rank: z.enum(['PRIMARY', 'SECONDARY']).default('SECONDARY'),
    // Chronic/ongoing conditions also go on the patient's problem list; the rest belong to this visit.
    onProblemList: z.boolean().default(false),
  }).strict().superRefine((body, ctx) => {
    const valid = body.codeSystem === 'ICD11' ? ICD11 : ICD10;
    if (!valid.test(body.code)) {
      ctx.addIssue({ code: 'custom', path: ['code'], message: body.codeSystem === 'ICD11' ? 'Must be an ICD-11 code such as 1F40 or CA40.0' : 'Must be an ICD-10 code such as J45 or J45.901' });
    }
  }),
});
export const markDiagnosis = z.object({ params: z.object({ ...enc, diagnosisId: z.uuid() }).strict(), query: noQuery, body: z.object({ reason }).strict() });
