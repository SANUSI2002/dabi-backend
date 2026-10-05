export const REQUIRED_CREDENTIALS = ['licence', 'registrationCertificate'];
export function latestCredentials(application) {
  return REQUIRED_CREDENTIALS.map((kind) => [...(application?.credentials || [])]
    .filter((doc) => doc.kind === kind).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt) || b.id.localeCompare(a.id))[0]).filter(Boolean);
}
export function eligibleDocument(doc) {
  return doc.scanStatus === 'CLEAN' && doc.storageBucket === 'sabi-hospital-evidence-clean';
}
export function approvalBlockers(profile, application, now = new Date()) {
  const blockers = [];
  if (profile.user?.accountStatus !== 'ACTIVE' || !profile.user?.emailVerifiedAt) blockers.push('Email verification is incomplete.');
  if (!application?.submittedAt) blockers.push('Credential submission is incomplete.');
  if (!['annual', 'life'].includes(application?.details?.licenceType)) blockers.push('Practising licence details are incomplete.');
  if (application?.details?.licenceType === 'annual') {
    const expiry = new Date(`${application.details.licenceExpiry}T23:59:59.999Z`);
    if (!Number.isFinite(expiry.getTime()) || expiry < now) blockers.push('Practising licence has expired or its expiry is invalid.');
  }
  for (const kind of REQUIRED_CREDENTIALS) {
    const doc = latestCredentials(application).find((item) => item.kind === kind);
    if (!doc) blockers.push(`Missing ${kind}.`);
    else {
      if (!eligibleDocument(doc)) blockers.push(`${kind}: clean malware screening required.`);
      if (doc.reviewStatus !== 'VERIFIED') blockers.push(`${kind}: authenticity verification required.`);
    }
  }
  return blockers;
}
