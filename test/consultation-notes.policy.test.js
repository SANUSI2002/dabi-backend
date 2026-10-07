// Consultation note rules that run in CI without a database. The full lifecycle and access
// rules are covered against real Postgres in test/emr-db/consultation-notes.db.test.js.
import { describe, expect, it } from 'vitest';
import { contentSchema, patientVisitSummary, saveSchema, signSchema, signingProblems } from '../src/modules/consultation-notes/consultation-notes.policy.js';

const PRIVATE = 'PRIVATE-CLINICAL-TEXT';
const content = contentSchema.parse({
  clinical: { presentingComplaint: PRIVATE, history: PRIVATE, findings: PRIVATE, assessment: PRIVATE, plan: PRIVATE },
  patient: { summary: 'We discussed your symptoms.', advice: 'Rest.', warningSigns: 'Seek care if worse.', followUp: { needed: true, timeframe: 'Two weeks', instructions: 'Book a follow-up.' } },
});
const note = (overrides = {}) => ({
  appointmentId: 'appointment', signedVersion: 2,
  versions: [
    { number: 1, signedAt: new Date('2026-10-07T10:00:00Z'), content: { ...content, patient: { ...content.patient, advice: 'Old advice' } } },
    { number: 2, signedAt: new Date('2026-10-07T12:00:00Z'), content, amendmentReason: `${PRIVATE} reason` },
  ],
  appointment: { startsAt: new Date('2026-10-07T09:00:00Z'), consultationType: 'VIRTUAL', dependent: { fullName: 'Synthetic Child' } },
  doctorProfile: { specialty: 'General practice', user: { full_name: 'Dr Synthetic' } },
  ...overrides,
});

describe('consultation note content', () => {
  it('fills every section so older drafts and partial saves parse the same way', () => {
    expect(contentSchema.parse({})).toEqual({
      clinical: { presentingComplaint: '', history: '', findings: '', assessment: '', plan: '' },
      patient: { summary: '', advice: '', warningSigns: '', followUp: { needed: false, timeframe: '', instructions: '' } },
    });
  });

  it('rejects unknown fields and oversized sections', () => {
    expect(contentSchema.safeParse({ clinical: { diagnosisCode: 'X' } }).success).toBe(false);
    expect(contentSchema.safeParse({ clinical: { assessment: 'a'.repeat(2001) } }).success).toBe(false);
    expect(saveSchema.safeParse({ body: { content: {}, extra: true } }).success).toBe(false);
  });

  it('requires a real amendment reason when one is given', () => {
    expect(signSchema.safeParse({ body: { revision: 1, amendmentReason: 'ok' } }).success).toBe(false);
    expect(signSchema.safeParse({ body: { revision: 1, amendmentReason: 'Corrected the advice' } }).success).toBe(true);
  });

  it('lists what is missing before a note can be signed', () => {
    expect(signingProblems(contentSchema.parse({}))).toEqual(['Add your assessment.', 'Add the plan.', 'Write the visit summary for the patient.']);
    expect(signingProblems(contentSchema.parse({ clinical: { assessment: 'a', plan: 'p' }, patient: { summary: 's', followUp: { needed: true } } }))).toEqual(['Say when the follow-up should happen.']);
    expect(signingProblems(content)).toEqual([]);
  });
});

describe('what the patient receives', () => {
  it('only the latest signed visit summary, never clinical text or amendment reasons', () => {
    const summary = patientVisitSummary(note());
    expect(summary).toMatchObject({
      appointmentId: 'appointment', version: 2, updated: true,
      doctor: { name: 'Dr Synthetic', specialty: 'General practice' },
      consultation: { consultationType: 'VIRTUAL', forName: 'Synthetic Child' },
      summary: content.patient,
    });
    expect(summary.history.map((h) => h.version)).toEqual([2, 1]);
    expect(JSON.stringify(summary)).not.toContain(PRIVATE);
  });

  it('nothing for unsigned notes', () => {
    expect(patientVisitSummary(note({ signedVersion: null }))).toBeNull();
  });
});
