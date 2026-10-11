// Synthetic commerce data for Command Centre tests: platform staff, patients and a verified
// marketplace pharmacy with one published, in-stock product. All fake; nothing is sent anywhere.
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createFacilityOwner } from '../../src/modules/identity/identity.repository.js';
import { reserveMarketplace } from '../../src/modules/pharmacies/marketplace.reservations.js';
import { prisma } from './fixtures.js';

const tag = () => randomUUID().slice(0, 8);
const nextYear = () => new Date(Date.now() + 365 * 86_400_000);

export function ensureDeliveryKey() {
  process.env.ORDER_DELIVERY_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
}

export async function person(name, { role, platformRoles = [], phone } = {}) {
  const user = await prisma.user.create({
    data: {
      patientId: `SABI-CC-${tag()}`,
      email: `${name.toLowerCase().replace(/[^a-z]+/g, '-')}-${tag()}@command.test`,
      password: 'synthetic-hash-only',
      full_name: name,
      phone_number: phone ?? null,
      accountStatus: 'ACTIVE',
      emailVerifiedAt: new Date(),
      ...(role ? { roles: { create: { role } } } : {}),
    },
  });
  if (platformRoles.length) await prisma.platformRoleAssignment.createMany({ data: platformRoles.map((roleCode) => ({ userId: user.id, roleCode })) });
  return user;
}

/**
 * A verified tier-3 pharmacy (10 km radius) with a branch at `at` and one published product at
 * `unitPriceMinor` per unit.
 */
export async function marketplacePharmacy({ at = { latitude: 6.5244, longitude: 3.3792 }, unitPriceMinor = 250_000, quantity = 50, tierLevel = 3 } = {}) {
  const owner = await person('Pharmacy Owner', { role: 'PHARMACY_ADMIN' });
  const reviewer = await person('Listing Reviewer', { platformRoles: ['SABI_PHARMACY_COMPLIANCE'] });
  const pharmacy = await prisma.pharmacy.create({
    data: {
      adminUserId: owner.id, name: `Synthetic Pharmacy ${tag()}`, address: '1 Synthetic Street', country: 'Nigeria', state: 'Lagos', city: 'Ikeja',
      contactEmail: owner.email, contactPhone: '+2347000000000', tierLevel, superintendentLicenceExpiresAt: nextYear(),
      registrationDetails: { cacNumber: 'TEST-CAC', superintendentName: 'Test Pharmacist', superintendentRegistrationNumber: 'TEST-PCN' },
      applicationSubmittedAt: new Date(), complianceStatus: 'VERIFIED', latitude: at.latitude, longitude: at.longitude,
    },
  });
  await prisma.$transaction((tx) => createFacilityOwner(tx, { userId: owner.id, pharmacyId: pharmacy.id, type: 'PHARMACY', roleCode: 'PHARMACY_ADMIN' }));
  const branch = await prisma.pharmacyBranch.create({
    data: { pharmacyId: pharmacy.id, name: 'Main branch', address: '1 Synthetic Road', latitude: at.latitude, longitude: at.longitude, premisesLicenceNumber: 'PCN-TEST', licenceExpiresAt: nextYear(), status: 'VERIFIED' },
  });
  const item = await prisma.pharmacyInventoryItem.create({
    data: { pharmacyId: pharmacy.id, branchId: branch.id, medicationName: `Synthetic thermometer ${tag()}`, availableQuantity: quantity, unitPriceMinor, isActive: true },
  });
  const listing = await prisma.pharmacyListing.create({
    data: { inventoryItemId: item.id, category: 'DEVICES', description: 'Synthetic test product, not for real sale', productClass: 'NON_MEDICINAL', status: 'PUBLISHED', imageBytes: Buffer.from('synthetic'), imageHash: 'b'.repeat(64), reviewedBy: reviewer.id, reviewedAt: new Date() },
  });
  return { owner, pharmacy, branch, item, listing };
}

/** Holds `quantity` of the listing for the patient (a marketplace cart). */
export const hold = (patient, listing, quantity = 1) => reserveMarketplace(patient.id, { idempotencyKey: randomUUID(), items: [{ listingId: listing.id, quantity }] });

/** A point `km` kilometres due north of `from` (straight-line). */
export const north = (from, km) => ({ latitude: from.latitude + km / 111.195, longitude: from.longitude });
