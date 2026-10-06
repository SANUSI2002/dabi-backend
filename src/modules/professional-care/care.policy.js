import { z } from 'zod';
const text = (max=2000) => z.string().trim().max(max);
const date = z.iso.date();
export const contentSchema = z.object({
  title: text(160).min(2), startsOn: date, endsOn: date,
  goals: text().min(2), preferences: text(), allergies: text(), restrictions: text(), history: text(4000), budget: text(300), instructions: text(4000),
  meals: z.array(z.object({ day: z.enum(['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']), time: text(50).min(1), food: text(500).min(1), portion: text(200), alternative: text(500), preparation: text(1000) }).strict()).max(70),
  targets: z.array(z.object({ name: text(100).min(1), value: text(100).min(1), source: z.url().refine(v => v.startsWith('https://'), 'Use a reliable HTTPS source.') }).strict()).max(20),
  activities: text(4000), followUpOn: date.optional().nullable(),
}).strict().refine(v => v.endsOn >= v.startsOn, 'Plan end date must not precede its start.');
export const saveSchema = z.object({ body: z.object({ patientId: z.uuid().optional(), revision: z.number().int().positive().optional(), content: contentSchema }).strict() });
export const revisionSchema = z.object({ body: z.object({ revision: z.number().int().positive() }).strict() });
export const feedbackSchema = z.object({ body: z.object({ version: z.number().int().positive(), message: text(2000).min(2), progress: z.enum(['ON_TRACK','NEEDS_HELP','NOT_STARTED']) }).strict() });
export const noteSchema = z.object({ body: z.object({ text: text(10000).min(2), followUpAt: z.iso.datetime().optional() }).strict() });
export const templateSchema = z.object({ body: z.object({ name: text(160).min(2), content: contentSchema }).strict() });
export const consentSchema = z.object({ body: z.object({ active: z.boolean(), consentVersion: z.literal('professional-care-v1') }).strict() });
export function patientPlan(plan) {
  // Explicit allowlist. Drafts, intake history and private notes never leak via spread.
  const version = plan.versions.find(v => v.number === plan.publishedVersion);
  if (!version) return null;
  const content = Object.fromEntries(Object.entries(version.content).filter(([key]) => key !== 'history'));
  return { id: plan.id, professionalId: plan.professionalId, kind: plan.kind, archivedAt: plan.archivedAt, publishedVersion: version.number, content, publishedAt: version.publishedAt,
    professional: plan.professional?.user?.full_name, feedback: plan.feedback || [], versions: plan.versions.map(v => ({ number: v.number, publishedAt: v.publishedAt })) };
}
