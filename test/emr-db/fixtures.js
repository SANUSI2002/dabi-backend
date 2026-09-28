// Synthetic tenants for the real-database EMR tests. All data is fake (".test" addresses, no
// real people); nothing is ever sent anywhere.
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import prisma from '../../src/config/db.js';

export const tokenFor = (userId, organizationId) =>
  `Bearer ${jwt.sign({ sub: userId, organizationId }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '10m' })}`;

const short = () => randomUUID().slice(0, 8);

async function user(label) {
  const tag = short();
  return prisma.user.create({
    data: { patientId: `SABI-T-${tag}`, email: `${label}-${tag}@emr.test`, password: 'not-a-real-hash', full_name: `${label} ${tag}`, accountStatus: 'ACTIVE', emailVerifiedAt: new Date() },
  });
}

let emrPackageVersion;
async function emrPackage(createdByUserId) {
  if (emrPackageVersion) return emrPackageVersion;
  const pkg = await prisma.platformPackage.create({ data: { code: `EMR-TEST-${short()}`, name: 'EMR Test', description: 'Test package' } });
  emrPackageVersion = await prisma.platformPackageVersion.create({
    data: { packageId: pkg.id, version: 1, status: 'PUBLISHED', monthlyPriceMinor: 0, annualPriceMinor: 0, moduleKeys: ['emr'], createdByUserId, publishedAt: new Date() },
  });
  return emrPackageVersion;
}

/** A verified hospital with an ACTIVE owner-admin membership and (by default) an EMR entitlement. */
export async function createTenant(label, { roles = ['HOSPITAL_ADMIN'], emr = true } = {}) {
  const owner = await user(`${label}-admin`);
  const facility = await prisma.organisation.create({
    data: { ownerId: owner.id, type: 'HOSPITAL', name: `${label} Hospital`, address: '1 Test Road', country: 'Nigeria', state: 'Lagos', city: 'Ikeja', contactEmail: `${label}-${short()}@hospital.test`, contactPhone: '+234 700 000 0000', status: 'VERIFIED' },
  });
  const organization = await prisma.identityOrganization.create({ data: { type: 'HOSPITAL', organisationId: facility.id } });
  if (emr) {
    const version = await emrPackage(owner.id);
    await prisma.platformApplication.create({
      data: {
        clientDraftId: randomUUID(), requestHash: short(), reference: `APP-${short()}`, ownerEmail: owner.email, organizationName: facility.name,
        status: 'APPROVED', details: {}, packageId: version.packageId, packageVersionId: version.id, billingCycle: 'Monthly',
        approvedOrganisationId: facility.id, approvedAt: new Date(), setupCompletedAt: new Date(),
      },
    });
  }
  const tenant = { organizationId: organization.id, facilityId: facility.id };
  const admin = await addMember(tenant, roles, owner);
  return { ...tenant, ...admin };
}

export async function addMember(tenant, roles, existing) {
  const member = existing ?? await user(roles.join('-').toLowerCase());
  // Clinical roles need a verified professional profile of the same type (identity rule).
  const profession = roles.find((role) => ['DOCTOR', 'NURSE', 'PHARMACIST'].includes(role));
  if (profession) {
    await prisma.professionalProfile.create({ data: { userId: member.id, professionType: profession, registrationNumber: `REG-${short()}`, verificationStatus: 'VERIFIED' } });
  }
  await prisma.organizationMembership.create({
    data: { userId: member.id, organizationId: tenant.organizationId, status: 'ACTIVE', joinedAt: new Date(), roles: { create: roles.map((roleCode) => ({ roleCode })) } },
  });
  return { userId: member.id, auth: tokenFor(member.id, tenant.organizationId) };
}

export const newPatient = (overrides = {}) => ({
  givenName: 'Ada', familyName: `Test${short()}`, dateOfBirth: '1990-04-12', sex: 'FEMALE',
  medicalRecordNumber: `MRN-${short().toUpperCase()}`, ...overrides,
});

export { prisma };
