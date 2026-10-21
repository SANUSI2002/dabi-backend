// Ward rounds.
//   /api/v1/emr/organizations/:organizationId/admissions/:admissionId/ward-rounds   list, start
//   /api/v1/emr/organizations/:organizationId/ward-rounds/:id/...                   draft, examination, sign,
//                                                                                    amendments, medication changes
//
// Who can do what (existing clinical permissions): reading needs clinical.read; a round is led by a
// clinician who diagnoses (diagnosis.record — the consultation room's rule), who also writes its draft and
// examination; signing and amending need clinical.note.sign as well; medication changes prescription.create.
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send } from '../core/http.js';
import { ROUTES } from '../pharmacy/formulary.catalog.js';
import { FREQUENCIES } from '../pharmacy/pharmacy.policy.js';
import * as wr from './wardrounds.service.js';

const org = { organizationId: z.uuid() };
const roundParams = { ...org, id: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const free = (max) => z.string().trim().max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])*$/u, 'Contains control characters');
const localId = z.string().max(40);
const yesNo = z.boolean().nullable();
const body = (shape, params = roundParams) => z.object({ params: z.object(params).strict(), query: noQuery, body: z.object(shape).strict() });

const participant = z.object({ id: localId, role: z.enum(['Consultant', 'Resident/Medical Officer', 'Nurse', 'Pharmacist', 'Physiotherapist', 'Dietician', 'Other']), name: text(120) }).strict();
const device = z.object({
  id: localId, kind: z.enum(['IV cannula', 'Central line', 'Urinary catheter', 'NG tube', 'Drain', 'Chest tube', 'Oxygen device', 'Other']), label: free(120).optional(),
  insertedAt: free(40).optional(), removedAt: free(40).optional(),
}).strict();
const problem = z.object({ id: localId, conditionId: z.string().max(64).optional(), problem: text(300), status: free(60), update: free(2000), plan: free(2000) }).strict();
const task = z.object({
  id: localId, type: text(40), description: text(1000), assignedTo: free(120).optional(), priority: z.enum(['Routine', 'Urgent', 'STAT']), dueAt: free(40).optional(),
  status: z.enum(['Pending', 'In Progress', 'Completed', 'Cancelled']),
}).strict();
const checklist = z.object(Object.fromEntries(['medicationReconciliationReviewed', 'drugAllergiesReviewed', 'antibioticsReviewed', 'anticoagulationReviewed', 'highRiskMedicinesReviewed',
  'prnMedicinesReviewed', 'ivMedicationReviewed', 'monitoringRequired', 'changesCommunicated'].map((k) => [k, z.boolean()]))).strict();
const discharge = z.object({ fit: yesNo, expectedDate: free(40).optional(), barriers: z.array(text(120)).max(20), criteria: free(2000).optional(), followUp: free(2000).optional() }).strict();
const communication = z.object({
  patientUpdated: yesNo, medicationChangesExplained: yesNo, planDiscussed: yesNo, caregiverUpdated: z.enum(['Yes', 'No', 'Not applicable']).nullable(), interpreterRequired: yesNo,
  questions: free(2000).optional(), notes: free(2000).optional(),
}).strict();
const system = z.object({
  system: z.enum(['general', 'cardiovascular', 'respiratory', 'abdominal', 'neurological', 'musculoskeletal', 'headAndNeck', 'skin', 'peripheralVascular', 'genitourinary', 'other']),
  status: z.enum(['Not Examined', 'Normal', 'Abnormal']), findings: z.record(z.string().max(60), free(500)).optional(), laterality: z.enum(['Left', 'Right', 'Bilateral', 'N/A']).optional(),
  notes: free(2000).optional(), consentDocumented: z.boolean().optional(), chaperoneDocumented: z.boolean().optional(),
}).strict();
const override = z.object({ drugCode: z.string().max(40), type: z.enum(['ALLERGY', 'MAX_DOSE', 'DUPLICATE_THERAPY']), reason: text(500) }).strict();
const frequency = z.enum(Object.keys(FREQUENCIES));

const v = {
  list: z.object({ params: z.object({ ...org, admissionId: z.uuid() }).strict(), query: noQuery }),
  start: body({ id: z.uuid().optional() }, { ...org, admissionId: z.uuid() }),
  update: z.object({
    params: z.object(roundParams).strict(), query: noQuery,
    body: z.object({
      participants: z.array(participant).max(30).optional(), clinicalProgress: z.enum(['', 'Improving', 'Stable', 'No significant change', 'Deteriorating', 'Critical']).optional(),
      progressNote: free(10000).optional(), devices: z.array(device).max(30).optional(), problems: z.array(problem).max(40).optional(), tasks: z.array(task).max(60).optional(),
      safetyChecklist: checklist.optional(), escalationPlan: free(2000).optional(), dischargeReadiness: discharge.optional(), communication: communication.optional(),
    }).strict().refine((b) => Object.values(b).some((x) => x !== undefined), 'Send at least one field to change'),
  }),
  examination: body({ systems: z.array(system).min(1).max(11) }),
  empty: body({}),
  amend: body({ note: text(4000) }),
  change: body({
    prescriptionItemId: z.uuid(), action: z.enum(['STOPPED', 'HELD', 'RESTARTED', 'DOSE_INCREASED', 'DOSE_DECREASED', 'FREQUENCY_CHANGED', 'ROUTE_CHANGED', 'REPLACED']),
    newDose: z.number().positive().max(1e6).optional(), newFrequency: frequency.optional(), newRoute: z.enum(ROUTES).optional(),
    reason: text(1000), clinicalNote: free(2000).optional(), monitoringRequired: free(1000).optional(), overrides: z.array(override).max(10).optional(),
  }),
  start_medication: body({
    drugCode: z.string().trim().max(40), dose: z.number().positive().max(1e6), doseUnit: text(20), frequency, route: z.enum(ROUTES).optional(),
    durationDays: z.number().int().min(1).max(365).optional(), quantity: z.number().int().min(1).max(10_000).optional(), prn: z.boolean().optional(), prnReason: text(200).optional(),
    instructions: text(500).optional(), indication: text(500).optional(), overrides: z.array(override).max(10).optional(),
  }),
};

export const admissionWardRoundRoutes = express.Router({ mergeParams: true });
admissionWardRoundRoutes.get('/', check(v.list), allow('clinical.read'), handle(async (req, res) => send(res, await wr.listRounds(req.emr, req.params.admissionId))));
admissionWardRoundRoutes.post('/', check(v.start), allow('diagnosis.record'), handle(async (req, res) => send(res, await wr.startRound(req.emr, req.params.admissionId, req.body), 201)));

export const wardRoundRoutes = express.Router({ mergeParams: true });
wardRoundRoutes.patch('/:id', check(v.update), allow('diagnosis.record'), handle(async (req, res) => send(res, await wr.updateDraft(req.emr, req.params.id, requireVersion(req), req.body))));
wardRoundRoutes.post('/:id/examination', check(v.examination), allow('diagnosis.record'), handle(async (req, res) => send(res, await wr.recordExamination(req.emr, req.params.id, req.body))));
wardRoundRoutes.post('/:id/sign', check(v.empty), allow('clinical.note.sign'), handle(async (req, res) => send(res, await wr.signRound(req.emr, req.params.id))));
wardRoundRoutes.post('/:id/amendments', check(v.amend), allow('clinical.note.sign'), handle(async (req, res) => send(res, await wr.amendRound(req.emr, req.params.id, req.body), 201)));
wardRoundRoutes.post('/:id/medication-changes', check(v.change), allow('prescription.create'), handle(async (req, res) => send(res, await wr.changeMedication(req.emr, req.params.id, req.body), 201)));
wardRoundRoutes.post('/:id/medications', check(v.start_medication), allow('prescription.create'), handle(async (req, res) => send(res, await wr.startMedication(req.emr, req.params.id, req.body), 201)));
