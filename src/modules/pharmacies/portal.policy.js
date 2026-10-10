import { PRIVATE_BUCKETS } from "../../config/privateStorage.js";
export const GLOBAL_CREDENTIALS = [
  "CAC_CERTIFICATE",
  "SUPERINTENDENT_LICENCE",
  "SUPERINTENDENT_APPOINTMENT",
];
export const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status });
};
export const hashDate = (value) => value && new Date(value);
export function latestCredentials(rows, branchId = null) {
  const byKind = new Map();
  for (const row of [...rows].sort(
    (a, b) =>
      new Date(b.createdAt) - new Date(a.createdAt) || b.id.localeCompare(a.id),
  )) {
    if ((row.branchId ?? null) === branchId && !byKind.has(row.kind))
      byKind.set(row.kind, row);
  }
  return [...byKind.values()];
}
export const clean = (doc) =>
  doc?.scanStatus === "CLEAN" &&
  doc.storageBucket === PRIVATE_BUCKETS.hospitalEvidenceClean;
export function pharmacyBlockers(pharmacy, now = new Date()) {
  const issues = [];
  if (
    !pharmacy.admin?.emailVerifiedAt ||
    pharmacy.admin?.accountStatus !== "ACTIVE"
  )
    issues.push(
      "The owner must verify their email and have an active account.",
    );
  if (!pharmacy.applicationSubmittedAt)
    issues.push("The pharmacy has not submitted its application.");
  if (!pharmacy.tier?.enabled) issues.push("An enabled tier must be assigned.");
  const branches = pharmacy.branches || [];
  if (!branches.length)
    issues.push("At least one pharmacy branch is required.");
  if (pharmacy.tier?.maxBranches && branches.length > pharmacy.tier.maxBranches)
    issues.push("The number of branches exceeds this tier.");
  const expiry = new Date(
    pharmacy.superintendentLicenceExpiresAt ||
      pharmacy.registrationDetails?.superintendentLicenceExpiresAt ||
      "",
  );
  if (!Number.isFinite(expiry.getTime()) || expiry <= now)
    issues.push(
      "The superintendent pharmacist licence expiry must be current.",
    );
  for (const kind of GLOBAL_CREDENTIALS) {
    const doc = latestCredentials(pharmacy.credentials || []).find(
      (d) => d.kind === kind,
    );
    if (!clean(doc) || doc?.reviewStatus !== "VERIFIED")
      issues.push(
        `${kind}: a clean document and independent authenticity review are required.`,
      );
  }
  for (const branch of branches) {
    const doc = latestCredentials(pharmacy.credentials || [], branch.id).find(
      (d) => d.kind === "PREMISES_LICENCE",
    );
    if (!clean(doc) || doc?.reviewStatus !== "VERIFIED")
      issues.push(`${branch.name}: reviewed premises licence required.`);
    if (
      !branch.licenceExpiresAt ||
      !Number.isFinite(new Date(branch.licenceExpiresAt).getTime()) ||
      new Date(branch.licenceExpiresAt) <= now
    )
      issues.push(`${branch.name}: premises licence expired.`);
  }
  return issues;
}
export function distanceKm(from, to) {
  const r = (x) => (x * Math.PI) / 180;
  const a =
    Math.sin(r(to.latitude - from.latitude) / 2) ** 2 +
    Math.cos(r(from.latitude)) *
      Math.cos(r(to.latitude)) *
      Math.sin(r(to.longitude - from.longitude) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}
export function commissionSnapshot(tier, subtotalMinor) {
  if (!tier?.enabled) fail("The pharmacy tier is unavailable.");
  if (!Number.isSafeInteger(subtotalMinor) || subtotalMinor < 0)
    fail("Invalid order subtotal.", 400);
  return {
    commissionBps: tier.commissionBps,
    commissionMinor: Math.round((subtotalMinor * tier.commissionBps) / 10000),
    tierVersion: tier.version,
  };
}
