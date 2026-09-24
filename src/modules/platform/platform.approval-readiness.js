// This is a server-owned gate. Browser compliance fixtures must never become
// evidence of a completed document review or an EMR entitlement.
const LAGOS_FACILITIES = new Set([
  'Private Hospital', 'Public Hospital', 'Clinic', 'Primary Health Centre',
  'Maternity Centre', 'Diagnostic Centre', 'Medical Laboratory',
  'Dental Hospital / Clinic', 'Eye Hospital / Clinic',
  'Physiotherapy Clinic', 'Dialysis Centre', 'Nursing / Convalescent Home',
  'Home Care Service', 'Mobile Clinic',
]);
const PRIVATE_OWNERSHIP = new Set(['Private', 'Faith-based', 'Non-profit', 'Corporate group', 'Other']);

export function requiredEvidence(details) {
  const organization = details?.organization;
  const registration = details?.regulatoryRegistration;
  if (!organization || !registration || organization.country !== 'Nigeria') return null;
  const requirements = ['OFFICER_LICENCE'];
  if (PRIVATE_OWNERSHIP.has(organization.ownershipType)) requirements.push('CAC_CERTIFICATE', 'TAX_EVIDENCE');
  if (organization.state?.toLowerCase() !== 'lagos' || !LAGOS_FACILITIES.has(organization.facilityType)) return null;
  requirements.push('FACILITY_REGISTRATION', 'WASTE_MANAGEMENT', 'HMIS_RENDITION');
  if (['Private Hospital', 'Public Hospital', 'Diagnostic Centre', 'Medical Laboratory', 'Maternity Centre'].includes(organization.facilityType)) requirements.push('SITE_DIAGRAM');
  if (registration.registrationStatus === 'EXISTING') requirements.push('PREVIOUS_CERTIFICATE');
  return requirements;
}

export function approvalReadiness(application, now = new Date()) {
  const blockers = [];
  const requirements = requiredEvidence(application.details);
  if (application.status !== 'UNDER_REVIEW') blockers.push('REVIEW_NOT_IN_PROGRESS');
  if (!application.emailVerifiedAt) blockers.push('OWNER_EMAIL_NOT_VERIFIED');
  if (!application.details?.selectedProducts?.includes('emr')) blockers.push('EMR_NOT_SELECTED');
  if (!application.packageVersion?.moduleKeys?.includes('emr') || application.packageVersion.status !== 'PUBLISHED') blockers.push('EMR_NOT_IN_PUBLISHED_PACKAGE');
  if (!requirements) blockers.push('MANUAL_REQUIREMENT_CONFIGURATION_REQUIRED');
  const evidence = application.evidence ?? [];
  for (const key of requirements ?? []) {
    const document = evidence.find((item) => item.requirementKey === key);
    if (!document) blockers.push(`MISSING_DOCUMENT:${key}`);
    else if (document.scanStatus !== 'CLEAN') blockers.push(`DOCUMENT_NOT_SCANNED:${key}`);
    else if (document.reviewStatus !== 'VERIFIED' || !document.reviewedByUserId || !document.reviewedAt) blockers.push(`DOCUMENT_NOT_VERIFIED:${key}`);
    else if (document.expiresAt && document.expiresAt <= now) blockers.push(`DOCUMENT_EXPIRED:${key}`);
  }
  // Remove this only when private upload, malware scanning, reviewer download,
  // and audited verification are all wired to this evidence table.
  blockers.push('SECURE_DOCUMENT_WORKFLOW_NOT_CONNECTED');
  return { ready: blockers.length === 0, requiredEvidence: requirements ?? [], blockers };
}
