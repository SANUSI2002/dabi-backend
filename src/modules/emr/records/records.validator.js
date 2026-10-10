import { z } from 'zod';
import { ICD10, ICD11 } from '../encounters/encounters.validator.js';

const params = { organizationId: z.uuid(), patientId: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');
const pastDate = z.iso.date().refine((d) => new Date(`${d}T00:00:00.000Z`).getTime() <= Date.now() + 86_400_000, 'The date cannot be in the future');
const clinicalStatus = z.enum(['ACTIVE', 'RECURRENCE', 'RELAPSE', 'INACTIVE', 'REMISSION', 'RESOLVED']);
const verificationStatus = z.enum(['UNCONFIRMED', 'PROVISIONAL', 'DIFFERENTIAL', 'CONFIRMED', 'REFUTED']);

export const record = z.object({ params: z.object(params).strict(), query: noQuery });

/** Either a coded problem (code + description) or one of the patient's flagged diagnoses. */
export const addProblem = z.object({
  params: z.object(params).strict(),
  query: noQuery,
  body: z.object({
    fromDiagnosisId: z.uuid().optional(),
    codeSystem: z.enum(['ICD10', 'ICD11']).default('ICD11'),
    code: z.string().trim().toUpperCase().optional(),
    description: text(300).optional(),
    clinicalStatus: clinicalStatus.optional(),
    verificationStatus: verificationStatus.optional(),
    onsetDate: pastDate.optional(),
    note: text(1000).optional(),
  }).strict().superRefine((body, ctx) => {
    if (body.fromDiagnosisId) {
      for (const field of ['code', 'description', 'onsetDate']) {
        if (body[field] !== undefined) ctx.addIssue({ code: 'custom', path: [field], message: 'Comes from the diagnosis; leave it out' });
      }
      return;
    }
    if (!body.description) ctx.addIssue({ code: 'custom', path: ['description'], message: 'Required' });
    const valid = body.codeSystem === 'ICD11' ? ICD11 : ICD10;
    if (!body.code || !valid.test(body.code)) {
      ctx.addIssue({ code: 'custom', path: ['code'], message: body.codeSystem === 'ICD11' ? 'Must be an ICD-11 code such as 1F40 or CA40.0' : 'Must be an ICD-10 code such as J45 or J45.901' });
    }
  }),
});

export const updateProblem = z.object({
  params: z.object({ ...params, problemId: z.uuid() }).strict(),
  query: noQuery,
  body: z.object({
    clinicalStatus: clinicalStatus.optional(),
    verificationStatus: verificationStatus.optional(),
    abatementDate: pastDate.nullable().optional(),
    note: text(1000).nullable().optional(),
  }).strict().refine((body) => Object.keys(body).length > 0, 'Nothing to change'),
});
