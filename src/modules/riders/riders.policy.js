import { PRIVATE_BUCKETS } from "../../config/privateStorage.js";
export const REQUIREMENTS = Object.freeze([
  { kind: "drivingLicence", label: "Current driving licence" },
  { kind: "vehicleRegistration", label: "Vehicle registration" },
  { kind: "insurance", label: "Current vehicle insurance" },
]);
export const CONSENT_VERSION = "sabi-rider-onboarding-v1";
export const latestCredentials = (rows = []) => {
  const seen = new Set();
  return [...rows]
    .sort(
      (a, b) =>
        b.revision - a.revision ||
        new Date(b.createdAt) - new Date(a.createdAt) ||
        b.id.localeCompare(a.id),
    )
    .filter((doc) => {
      if (seen.has(doc.kind)) return false;
      seen.add(doc.kind);
      return true;
    });
};
export const cleanCredential = (doc) =>
  doc?.scanStatus === "CLEAN" &&
  doc.storageBucket === PRIVATE_BUCKETS.hospitalEvidenceClean &&
  !!doc.scannedAt &&
  !!doc.scannerVersion;
export const currentDate = (now = new Date()) => now.toISOString().slice(0, 10);
export function approvalBlockers(app, now = new Date()) {
  const blockers = [];
  if (!app.submittedAt || app.status !== "SUBMITTED")
    blockers.push("Application must be submitted for review.");
  if (app.user.accountStatus !== "ACTIVE" || !app.user.emailVerifiedAt)
    blockers.push("An active email-verified Sabi account is required.");
  if (app.licenceExpiresAt.toISOString().slice(0, 10) <= currentDate(now))
    blockers.push("Driving licence has expired.");
  if (app.insuranceExpiresAt.toISOString().slice(0, 10) <= currentDate(now))
    blockers.push("Vehicle insurance has expired.");
  const docs = latestCredentials(app.credentials);
  for (const { kind, label } of REQUIREMENTS) {
    const doc = docs.find((row) => row.kind === kind);
    if (!doc) blockers.push(`${label}: upload required.`);
    else {
      if (!cleanCredential(doc))
        blockers.push(`${label}: clean malware screening required.`);
      if (doc.reviewStatus !== "VERIFIED")
        blockers.push(`${label}: authenticity review required.`);
    }
  }
  return blockers;
}
