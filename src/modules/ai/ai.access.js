import { z } from 'zod';
import prisma from '../../config/db.js';
import { aiError } from './ai.config.js';

export const AI_PROFESSIONS = [
  { id: 'DOCTOR', label: 'Medical doctor', authority: 'MDCN', url: 'https://www.mdcn.gov.ng/' },
  { id: 'DENTIST', label: 'Dentist', authority: 'MDCN', url: 'https://www.mdcn.gov.ng/' },
  { id: 'NURSE', label: 'Registered nurse', authority: 'NMCN', url: 'https://local-verification.nmcn.gov.ng/' },
  { id: 'MIDWIFE', label: 'Registered midwife', authority: 'NMCN', url: 'https://local-verification.nmcn.gov.ng/' },
  { id: 'PHARMACIST', label: 'Pharmacist', authority: 'PCN', url: 'https://pcn.gov.ng/' },
  { id: 'PHYSIOTHERAPIST', label: 'Physiotherapist / rehabilitation therapist', authority: 'MRTB', url: 'https://www.mrtb.gov.ng/en/' },
  { id: 'LABORATORY_SCIENTIST', label: 'Medical laboratory scientist', authority: 'MLSCN', url: 'https://www.mlscn.gov.ng/' },
  { id: 'RADIOGRAPHER', label: 'Radiographer', authority: 'RRBN', url: 'https://services.rrbn.gov.ng/' },
  { id: 'OPTOMETRIST', label: 'Optometrist / dispensing optician', authority: 'ODORBN', url: 'https://odorbn.gov.ng/' },
  { id: 'COMMUNITY_HEALTH', label: 'Community health practitioner', authority: 'CHPRBN', url: 'https://app.chprbn.gov.ng/verify' },
  { id: 'OTHER', label: 'Other professional discipline', authority: null, url: null },
];
export const featureSchema = z.object({ chat: z.boolean(), knowledge: z.boolean(), documents: z.boolean(), reminders: z.boolean(), memory: z.boolean() }).strict();
export const accessSettingsSchema = z.object({ PERSONAL: featureSchema, PROFESSIONAL: featureSchema, BUSINESS: featureSchema }).strict();
export const enrollmentSchema = z.object({
  kind: z.enum(['PERSONAL','PROFESSIONAL','BUSINESS']),
  profession: z.enum(AI_PROFESSIONS.map(p => p.id)).optional(), country: z.string().trim().min(2).max(80).transform(v=>v.toLowerCase()==='nigeria'?'Nigeria':v).default('Nigeria'),
  authority: z.string().trim().min(2).max(160).optional(), licenceNumber: z.string().trim().min(3).max(100).optional(),
  expiresAt: z.iso.date().optional(), organizationName: z.string().trim().min(2).max(180).optional(),
  registrationNumber: z.string().trim().min(3).max(100).optional(),
  attestation: z.literal(true),
}).strict().superRefine((v, ctx) => {
  if (v.kind === 'PROFESSIONAL') for (const field of ['profession','authority','licenceNumber','expiresAt']) if (!v[field]) ctx.addIssue({ code:'custom', path:[field], message:'Required for professional review.' });
  if (v.kind === 'BUSINESS') for (const field of ['organizationName','registrationNumber','authority']) if (!v[field]) ctx.addIssue({ code:'custom', path:[field], message:'Required for business review.' });
  if (v.expiresAt && new Date(`${v.expiresAt}T23:59:59Z`) < new Date()) ctx.addIssue({ code:'custom', path:['expiresAt'], message:'Use a current licence.' });
  const profession = AI_PROFESSIONS.find(p => p.id === v.profession);
  if (v.kind === 'PROFESSIONAL' && v.country === 'Nigeria' && profession?.authority && v.authority !== profession.authority) ctx.addIssue({ code:'custom', path:['authority'], message:'Use the regulator for this discipline.' });
});
export async function aiAccess(userId, db = prisma) {
  const [policy, enrollment, professional] = await Promise.all([
    db.aiAccessPolicy.findUnique({ where: { id:'global' } }),
    db.aiEnrollment.findUnique({ where: { userId } }),
    db.professionalProfile.findUnique({ where: { userId }, select: { verificationStatus:true } }),
  ]);
  const valid = enrollment?.status === 'APPROVED' && (!enrollment.expiresAt || enrollment.expiresAt > new Date());
  // An AI approval never grants a clinical role, patient access or prescribing permissions.
  const category = valid ? enrollment.kind : professional?.verificationStatus === 'VERIFIED' ? 'PROFESSIONAL' : 'PERSONAL';
  const parsed = accessSettingsSchema.safeParse(policy?.settings);
  const defaults = parsed.success ? parsed.data[category] : { chat:false,knowledge:false,documents:false,reminders:false,memory:false };
  const overrides=featureSchema.partial().safeParse(enrollment?.featureOverrides||{});
  const features=enrollment?.status==='SUSPENDED'?{chat:false,knowledge:false,documents:false,reminders:false,memory:false}:{...defaults,...(overrides.success?overrides.data:{})};
  return { category, features, policyVersion: policy?.version ?? 0, enrollment: enrollment ? { kind:enrollment.kind, status:enrollment.status, version:enrollment.version, expiresAt:enrollment.expiresAt, details:enrollment.details, decisionReason:enrollment.decisionReason } : null };
}
export async function requireAiFeature(userId, feature, db = prisma) {
  const access = await aiAccess(userId, db);
  if (!access.features[feature]) throw aiError(403,'AI_FEATURE_DENIED','This feature is not enabled for your Sabi AI account.');
  return access;
}
