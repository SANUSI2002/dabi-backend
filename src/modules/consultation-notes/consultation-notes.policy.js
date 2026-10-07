// Consultation note content and what each audience may see.
//
// A note has two parts:
// - `clinical`: the doctor's private record (complaint, history, findings, assessment, plan).
//   Never returned to the patient.
// - `patient`: the visit summary written for the patient. Only signed versions are shared.
import { z } from 'zod';

const text = (max) => z.string().trim().max(max).default('');

export const clinicalSchema = z.object({
  presentingComplaint: text(2000),
  history: text(4000),
  findings: text(4000),
  assessment: text(2000),
  plan: text(4000),
}).strict();

export const followUpSchema = z.object({
  needed: z.boolean().default(false),
  timeframe: text(120),
  instructions: text(1000),
}).strict();

export const visitSummarySchema = z.object({
  summary: text(3000),
  advice: text(3000),
  warningSigns: text(1500),
  followUp: followUpSchema.prefault({}),
}).strict();

export const contentSchema = z.object({
  clinical: clinicalSchema.prefault({}),
  patient: visitSummarySchema.prefault({}),
}).strict();

export const saveSchema = z.object({
  body: z.object({
    // Omitted when starting a note; required (and must match) when updating one.
    revision: z.number().int().min(1).optional(),
    content: contentSchema,
  }).strict(),
});

export const signSchema = z.object({
  body: z.object({
    revision: z.number().int().min(1),
    // Required for every signature after the first.
    amendmentReason: z.string().trim().min(5).max(500).optional(),
  }).strict(),
});

export const appointmentParams = z.object({ params: z.object({ appointmentId: z.uuid() }).strict() });

export const practiceListSchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  }).strict(),
});

/** What a signature needs, as patient-readable problems (empty when the note can be signed). */
export function signingProblems(content) {
  const problems = [];
  if (!content.clinical.assessment) problems.push('Add your assessment.');
  if (!content.clinical.plan) problems.push('Add the plan.');
  if (!content.patient.summary) problems.push('Write the visit summary for the patient.');
  if (content.patient.followUp.needed && !content.patient.followUp.timeframe) problems.push('Say when the follow-up should happen.');
  return problems;
}

/**
 * The patient's view of a note: the latest signed visit summary and the dates of earlier
 * signatures. Drafts, clinical sections and amendment reasons are never included.
 * Returns null when nothing has been signed.
 */
export function patientVisitSummary(note) {
  if (!note.signedVersion) return null;
  const versions = [...note.versions].sort((a, b) => b.number - a.number);
  const current = versions.find((v) => v.number === note.signedVersion);
  if (!current) return null;
  const parsed = contentSchema.parse(current.content);
  const appointment = note.appointment;
  return {
    appointmentId: note.appointmentId,
    version: current.number,
    signedAt: current.signedAt,
    updated: current.number > 1,
    history: versions.filter((v) => v.number <= note.signedVersion).map((v) => ({ version: v.number, signedAt: v.signedAt })),
    consultation: {
      startsAt: appointment.startsAt,
      consultationType: appointment.consultationType,
      forName: appointment.dependent?.fullName ?? null,
    },
    doctor: {
      name: note.doctorProfile.user?.full_name ?? null,
      specialty: note.doctorProfile.specialty ?? null,
    },
    summary: parsed.patient,
  };
}
