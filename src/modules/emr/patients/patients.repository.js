// Patient data access. Every function takes the tenant transaction from withTenant; the explicit
// organizationId filters are defence in depth on top of row-level security.
import { updateVersioned } from '../core/concurrency.js';
import { page } from '../core/cursor.js';

export const patientSelect = {
  id: true, medicalRecordNumber: true, givenName: true, familyName: true, otherNames: true,
  dateOfBirth: true, sex: true, status: true, phone: true, email: true, address: true, state: true,
  lga: true, nationalId: true, nextOfKinName: true, nextOfKinPhone: true, nextOfKinRelationship: true,
  consentToContact: true, preferredName: true, payer: true, category: true, hospitalNumber: true, language: true,
  occupation: true, bloodGroup: true, addressWard: true, emergencyContactName: true, emergencyContactPhone: true,
  emergencyContactRelationship: true, linkedUserId: true, deactivatedAt: true, deactivationReason: true,
  version: true, createdAt: true, updatedAt: true,
};
const summarySelect = {
  id: true, medicalRecordNumber: true, givenName: true, familyName: true, otherNames: true, preferredName: true, dateOfBirth: true, sex: true,
  status: true, phone: true, nationalId: true, hospitalNumber: true, payer: true, category: true, state: true, lga: true, version: true, createdAt: true,
};

const statusWhere = (status) => (status === 'ALL' ? {} : { status });

// Search: MRN / national ID prefix, or name contains. Scoped to the tenant first, so the
// (organization_id, …) indexes bound the scan to one hospital's rows.
const searchWhere = (q) => (q ? { OR: [
  { medicalRecordNumber: { startsWith: q.toUpperCase() } },
  { nationalId: { startsWith: q.toUpperCase() } },
  { hospitalNumber: { startsWith: q.toUpperCase() } },
  { phone: { contains: q } },
  { givenName: { contains: q, mode: 'insensitive' } },
  { familyName: { contains: q, mode: 'insensitive' } },
  { otherNames: { contains: q, mode: 'insensitive' } },
] } : {});

/** Keyset page ordered newest first — constant cost regardless of how deep the client pages. */
export async function listPatients(tx, organizationId, { q, status, limit, after }) {
  // `after` (from afterCursor) is an OR clause, as is the search: combine them with AND.
  const where = { organizationId, ...statusWhere(status), ...searchWhere(q), AND: [after] };
  const rows = await tx.emrPatient.findMany({ where, select: summarySelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
  return page(rows, limit, 'createdAt');
}

export const countPatients = (tx, organizationId, { q, status }) =>
  tx.emrPatient.count({ where: { organizationId, ...statusWhere(status), ...searchWhere(q) } });

/**
 * Pairs of active patients in one hospital sharing a phone number, or the same full name and date
 * of birth — for staff review (records are never merged automatically).
 */
export async function duplicatePairs(tx, organizationId, limit) {
  const rows = await tx.$queryRaw`
    SELECT a."id" AS "leftId", b."id" AS "rightId",
           (a."phone" IS NOT NULL AND a."phone" = b."phone") AS "samePhone",
           (lower(a."family_name") = lower(b."family_name") AND lower(a."given_name") = lower(b."given_name")
             AND a."date_of_birth" = b."date_of_birth") AS "sameNameDob"
    FROM "emr_patients" a
    JOIN "emr_patients" b ON b."organization_id" = a."organization_id" AND a."id" < b."id"
      AND ((a."phone" IS NOT NULL AND b."phone" = a."phone")
        OR (lower(b."family_name") = lower(a."family_name") AND lower(b."given_name") = lower(a."given_name")
          AND b."date_of_birth" = a."date_of_birth"))
    WHERE a."organization_id" = ${organizationId} AND a."status" = 'ACTIVE' AND b."status" = 'ACTIVE'
    ORDER BY a."id", b."id"
    LIMIT ${limit}`;
  if (!rows.length) return [];
  const ids = [...new Set(rows.flatMap((r) => [r.leftId, r.rightId]))];
  const patients = await tx.emrPatient.findMany({ where: { organizationId, id: { in: ids } }, select: summarySelect });
  const byId = new Map(patients.map((p) => [p.id, p]));
  return rows.map((r) => ({
    left: byId.get(r.leftId),
    right: byId.get(r.rightId),
    reasons: [...(r.samePhone ? ['SAME_PHONE'] : []), ...(r.sameNameDob ? ['SAME_NAME_AND_DATE_OF_BIRTH'] : [])],
  }));
}

/** Legacy offset paging (page ≤ 100). */
export async function listPatientsPage(tx, organizationId, { q, status, limit, page }) {
  const rows = await tx.emrPatient.findMany({
    where: { organizationId, ...statusWhere(status), ...searchWhere(q) },
    select: summarySelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit + 1,
  });
  return { items: rows.slice(0, limit), nextPage: rows.length > limit ? page + 1 : null };
}

export const findPatient = (tx, organizationId, id, select = patientSelect) =>
  tx.emrPatient.findFirst({ where: { organizationId, id }, select });

export const createPatient = (tx, data) => tx.emrPatient.create({ data, select: patientSelect });

export const updatePatient = (tx, { organizationId, id, expectedVersion, data }) =>
  updateVersioned(tx.emrPatient, { organizationId, id, expectedVersion, data, select: patientSelect, notFoundCode: 'PATIENT_NOT_FOUND' });

export async function findDuplicates(tx, organizationId, { givenName, familyName, dateOfBirth, nationalId, phone }) {
  const OR = [];
  if (nationalId) OR.push({ nationalId });
  if (phone) OR.push({ phone });
  if (familyName && dateOfBirth) {
    OR.push({
      familyName: { equals: familyName, mode: 'insensitive' },
      dateOfBirth: new Date(`${dateOfBirth}T00:00:00.000Z`),
      ...(givenName ? { givenName: { startsWith: givenName.slice(0, 1), mode: 'insensitive' } } : {}),
    });
  } else if (familyName && givenName) {
    // Same full name before a date of birth is typed: a weaker hint shown while the form is filled in.
    OR.push({ familyName: { equals: familyName, mode: 'insensitive' }, givenName: { equals: givenName, mode: 'insensitive' } });
  }
  return tx.emrPatient.findMany({ where: { organizationId, OR }, select: summarySelect, orderBy: { createdAt: 'desc' }, take: 10 });
}
