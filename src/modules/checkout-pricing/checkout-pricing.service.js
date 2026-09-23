import * as repository from './checkout-pricing.repository.js';

const fail = (code) => Object.assign(new Error(code), { code });
const DEFAULT_CONFIGURATION = Object.freeze({
  version: 0,
  platformFeeMinor: 0,
  deliveryRatePerKmMinor: 60000,
  currency: 'NGN',
  effectiveAt: null,
});

const distanceKm = (from, to) => {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const latitude = radians(to.latitude - from.latitude);
  const longitude = radians(to.longitude - from.longitude);
  const value = Math.sin(latitude / 2) ** 2
    + Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(longitude / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};

const configuration = async () => (await repository.currentConfiguration()) ?? DEFAULT_CONFIGURATION;

export const readConfiguration = async (userId) => {
  if (!await repository.isSuperAdmin(userId)) throw fail('FORBIDDEN');
  return configuration();
};

export const updateConfiguration = async (userId, values) => {
  if (!await repository.isSuperAdmin(userId)) throw fail('FORBIDDEN');
  return repository.createConfiguration(userId, values);
};

export const preview = async (patientId, reservationId, selections, deliveryCoordinates) => {
  if (!await repository.isPatient(patientId)) throw fail('FORBIDDEN');
  const [pricing, reservation] = await Promise.all([
    configuration(),
    repository.activeReservation(patientId, reservationId),
  ]);
  if (!reservation) throw fail('NOT_FOUND');

  const byPharmacy = new Map();
  for (const allocation of reservation.allocations) {
    const existing = byPharmacy.get(allocation.pharmacyId) ?? [];
    existing.push(allocation);
    byPharmacy.set(allocation.pharmacyId, existing);
  }
  const selectedIds = selections.map((selection) => selection.pharmacyId);
  if (new Set(selectedIds).size !== selectedIds.length
    || selectedIds.length !== byPharmacy.size
    || selectedIds.some((id) => !byPharmacy.has(id))) throw fail('INVALID');

  const deliverySelected = selections.some((selection) => selection.fulfilmentMethod === 'DELIVERY');
  if (deliverySelected && !deliveryCoordinates) throw fail('INVALID');

  const pharmacies = selections.map((selection) => {
    const allocations = byPharmacy.get(selection.pharmacyId);
    const pharmacy = allocations[0].pharmacy;
    const subtotalMinor = allocations.reduce((total, allocation) => total + allocation.lineTotalMinor, 0);
    const supportsMethod = selection.fulfilmentMethod === 'PICKUP'
      ? allocations.every((allocation) => allocation.quoteItem.pickupAvailable)
      : allocations.every((allocation) => allocation.quoteItem.deliveryAvailable);
    if (!supportsMethod || pharmacy.complianceStatus !== 'VERIFIED') throw fail('INVALID');

    let deliveryFeeMinor = 0;
    let calculatedDistanceKm = null;
    if (selection.fulfilmentMethod === 'DELIVERY') {
      if (!Number.isFinite(pharmacy.latitude) || !Number.isFinite(pharmacy.longitude)) throw fail('INVALID');
      calculatedDistanceKm = distanceKm(pharmacy, deliveryCoordinates);
      deliveryFeeMinor = Math.round(calculatedDistanceKm * pricing.deliveryRatePerKmMinor);
    }
    return {
      pharmacy: {
        id: pharmacy.id,
        name: pharmacy.name,
        address: pharmacy.address,
        country: pharmacy.country,
        state: pharmacy.state,
        city: pharmacy.city,
      },
      fulfilmentMethod: selection.fulfilmentMethod,
      subtotalMinor,
      deliveryFeeMinor,
      distanceKm: calculatedDistanceKm === null ? null : Number(calculatedDistanceKm.toFixed(3)),
      totalMinor: subtotalMinor + deliveryFeeMinor,
    };
  });

  const subtotalMinor = pharmacies.reduce((total, pharmacy) => total + pharmacy.subtotalMinor, 0);
  const deliveryFeeMinor = pharmacies.reduce((total, pharmacy) => total + pharmacy.deliveryFeeMinor, 0);
  return {
    reservationId: reservation.id,
    reservationExpiresAt: reservation.expiresAt,
    currency: pricing.currency,
    pricingConfiguration: {
      version: pricing.version,
      effectiveAt: pricing.effectiveAt,
      platformFeeMinor: pricing.platformFeeMinor,
      deliveryRatePerKmMinor: pricing.deliveryRatePerKmMinor,
    },
    pharmacies,
    subtotalMinor,
    deliveryFeeMinor,
    platformFeeMinor: pricing.platformFeeMinor,
    totalPayableMinor: subtotalMinor + deliveryFeeMinor + pricing.platformFeeMinor,
  };
};
