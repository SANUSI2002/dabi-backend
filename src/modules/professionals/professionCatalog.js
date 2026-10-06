// Scope is deliberately narrower than the title: approval is not a licence to
// prescribe or browse unrelated clinical records. Review qualifications manually.
const evidence = (kind, label) => ({ kind, label });
export const PROFESSION_CATALOG = [
  { type: 'DOCTOR', label: 'Doctor', disciplines: ['MEDICAL_PRACTITIONER'], regulator: 'MDCN', regulated: true, clinicalRecords: true, prescribe: true, credentials: [evidence('licence', 'Current practising licence'), evidence('registrationCertificate', 'MDCN registration certificate')] },
  { type: 'NUTRITIONIST_DIETITIAN', label: 'Nutritionist / Dietitian', disciplines: ['DIETITIAN', 'NUTRITIONIST'], regulator: 'Qualification and professional competence review', regulated: false, credentials: [evidence('qualification', 'Nutrition / dietetics qualification'), evidence('competence', 'Internship, professional competence or membership evidence')] },
  { type: 'PSYCHOLOGIST', label: 'Clinical psychologist', disciplines: ['CLINICAL_PSYCHOLOGIST'], regulator: 'Qualification and supervised clinical practice review', regulated: false, credentials: [evidence('qualification', 'Clinical psychology qualification'), evidence('competence', 'Supervised practice and professional standing evidence')] },
  { type: 'COUNSELLOR', label: 'Counsellor', disciplines: ['COUNSELLOR'], regulator: 'Counselling professional standing review', regulated: false, credentials: [evidence('qualification', 'Counselling qualification'), evidence('competence', 'Professional registration / licensing and supervised practice evidence')] },
  { type: 'CAREGIVER', label: 'Caregiver', disciplines: ['NON_CLINICAL_CAREGIVER', 'REGISTERED_NURSE'], regulator: 'NMCN for registered nurses only', regulated: false, credentials: [evidence('qualification', 'Care training / qualification'), evidence('competence', 'Training, references and competence evidence')] },
  { type: 'FITNESS_COACH', label: 'Fitness coach', disciplines: ['FITNESS_COACH'], regulator: 'Platform qualification review; not rehabilitation practice', regulated: false, credentials: [evidence('qualification', 'Coaching qualification'), evidence('competence', 'First aid / competence and professional references')] },
  { type: 'HEALTH_EDUCATOR', label: 'Health educator', disciplines: ['HEALTH_EDUCATOR', 'COMMUNITY_HEALTH_PRACTITIONER'], regulator: 'CHPRBN for registered community-health practitioners only', regulated: false, credentials: [evidence('qualification', 'Health education qualification'), evidence('competence', 'Professional competence / registration evidence')] },
];
export const PORTAL_PROFESSIONS = PROFESSION_CATALOG.map((p) => p.type);
export const professionDefinition = (type) => PROFESSION_CATALOG.find((p) => p.type === type);
export function credentialRequirements(details = {}) {
  const definition = professionDefinition(details.professionType || 'DOCTOR');
  if (!definition) return [];
  if (['REGISTERED_NURSE', 'COMMUNITY_HEALTH_PRACTITIONER'].includes(details.discipline)) return [evidence('qualification', 'Professional qualification'), evidence('licence', 'Current practising licence'), evidence('registrationCertificate', 'Regulator registration certificate')];
  return definition.credentials;
}
export const needsCurrentLicence = (details = {}) => !details.professionType || details.professionType === 'DOCTOR' || ['REGISTERED_NURSE', 'COMMUNITY_HEALTH_PRACTITIONER'].includes(details.discipline);
export function capabilities(profile, details = {}) {
  const approved = profile?.verificationStatus === 'VERIFIED';
  const doctor = profile?.professionType === 'DOCTOR';
  return { appointments: approved, availability: approved, clinicalRecords: approved && doctor, prescribe: approved && doctor,
    nutrition: approved && profile?.professionType === 'NUTRITIONIST_DIETITIAN' && details.discipline === 'DIETITIAN',
    carePlans: approved && PORTAL_PROFESSIONS.includes(profile?.professionType) && !doctor };
}
