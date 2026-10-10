import * as repository from "./checkout-pricing.repository.js";

const fail = (code) => Object.assign(new Error(code), { code });
const DEFAULT_CONFIGURATION = Object.freeze({
  version: 0,
  platformFeeMinor: 0,
  deliveryRatePerKmMinor: 60000,
  currency: "NGN",
  effectiveAt: null,
});

const distanceKm = (from, to) => {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const latitude = radians(to.latitude - from.latitude);
  const longitude = radians(to.longitude - from.longitude);
  const value =
    Math.sin(latitude / 2) ** 2 +
    Math.cos(radians(from.latitude)) *
      Math.cos(radians(to.latitude)) *
      Math.sin(longitude / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};

const configuration = async () =>
  (await repository.currentConfiguration()) ?? DEFAULT_CONFIGURATION;

export const readConfiguration = async (userId) => {
  if (!(await repository.isSuperAdmin(userId))) throw fail("FORBIDDEN");
  return configuration();
};

export const updateConfiguration = async (userId, values) => {
  if (!(await repository.isSuperAdmin(userId))) throw fail("FORBIDDEN");
  return repository.createConfiguration(userId, values);
};

export const preview = async (
  patientId,
  reservationId,
  selections,
  deliveryCoordinates,
) => {
  if (!(await repository.isPatient(patientId))) throw fail("FORBIDDEN");
  const [pricing, reservation] = await Promise.all([
    configuration(),
    repository.activeReservation(patientId, reservationId),
  ]);
  if (!reservation) throw fail("NOT_FOUND");

  const byPharmacy = new Map();
  for (const allocation of reservation.allocations) {
    const existing = byPharmacy.get(allocation.pharmacyId) ?? [];
    existing.push(allocation);
    byPharmacy.set(allocation.pharmacyId, existing);
  }
  const selectedIds = selections.map((selection) => selection.pharmacyId);
  if (
    new Set(selectedIds).size !== selectedIds.length ||
    selectedIds.length !== byPharmacy.size ||
    selectedIds.some((id) => !byPharmacy.has(id))
  )
    throw fail("INVALID");

  const deliverySelected = selections.some(
    (selection) => selection.fulfilmentMethod === "DELIVERY",
  );
  if (deliverySelected && !deliveryCoordinates) throw fail("INVALID");

  const pharmacies = selections.map((selection) => {
    const allocations = byPharmacy.get(selection.pharmacyId);
    const pharmacy = allocations[0].pharmacy;
    const subtotalMinor = allocations.reduce(
      (total, allocation) => total + allocation.lineTotalMinor,
      0,
    );
    const supportsMethod =
      reservation.kind === "MARKETPLACE"
        ? Boolean(
            pharmacy.tier &&
            (selection.fulfilmentMethod === "PICKUP"
              ? pharmacy.tier.pickupEnabled
              : pharmacy.tier.deliveryEnabled),
          )
        : selection.fulfilmentMethod === "PICKUP"
          ? allocations.every(
              (allocation) => allocation.quoteItem.pickupAvailable,
            )
          : allocations.every(
              (allocation) => allocation.quoteItem.deliveryAvailable,
            );
    if (!supportsMethod || pharmacy.complianceStatus !== "VERIFIED")
      throw fail("INVALID");
    const tier = pharmacy.tier;
    if (
      tier &&
      allocations.some(
        (a) =>
          (reservation.kind !== "MARKETPLACE" ||
            a.inventoryItem.listing?.productClass !== "NON_MEDICINAL") &&
          (!a.inventoryItem.batchNumber ||
            !a.inventoryItem.expiryDate ||
            new Date(a.inventoryItem.expiryDate) <= new Date()),
      )
    )
      throw fail("INVALID");
    const branch = allocations[0].inventoryItem?.branch;
    if (
      tier &&
      (!tier.enabled ||
        !branch ||
        branch.status !== "VERIFIED" ||
        new Date(branch.licenceExpiresAt) <= new Date() ||
        pharmacy.admin?.accountStatus !== "ACTIVE" ||
        !pharmacy.admin?.emailVerifiedAt ||
        !pharmacy.superintendentLicenceExpiresAt ||
        new Date(pharmacy.superintendentLicenceExpiresAt) <= new Date() ||
        allocations.some((a) => a.inventoryItem?.branch?.id !== branch.id) ||
        subtotalMinor < tier.minimumOrderMinor ||
        (selection.fulfilmentMethod === "PICKUP"
          ? !tier.pickupEnabled
          : !tier.deliveryEnabled))
    )
      throw fail("INVALID");
    if (
      reservation.kind === "MARKETPLACE" &&
      allocations.some(
        (a) =>
          !a.inventoryItem?.isActive ||
          a.inventoryItem.listing?.status !== "PUBLISHED" ||
          !a.inventoryItem.listing.imageHash ||
          a.inventoryItem.listing.productClass === "PRESCRIPTION_ONLY",
      )
    )
      throw fail("INVALID");

    let deliveryFeeMinor = 0;
    let calculatedDistanceKm = null;
    if (selection.fulfilmentMethod === "DELIVERY") {
      const origin = tier ? branch : pharmacy;
      if (
        !Number.isFinite(origin.latitude) ||
        !Number.isFinite(origin.longitude)
      )
        throw fail("INVALID");
      calculatedDistanceKm = distanceKm(origin, deliveryCoordinates);
      if (tier && calculatedDistanceKm > tier.deliveryRadiusKm)
        throw fail("INVALID");
      deliveryFeeMinor = Math.round(
        calculatedDistanceKm * pricing.deliveryRatePerKmMinor,
      );
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
      distanceKm:
        calculatedDistanceKm === null
          ? null
          : Number(calculatedDistanceKm.toFixed(3)),
      totalMinor: subtotalMinor + deliveryFeeMinor,
    };
  });

  const subtotalMinor = pharmacies.reduce(
    (total, pharmacy) => total + pharmacy.subtotalMinor,
    0,
  );
  const deliveryFeeMinor = pharmacies.reduce(
    (total, pharmacy) => total + pharmacy.deliveryFeeMinor,
    0,
  );
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
    totalPayableMinor:
      subtotalMinor + deliveryFeeMinor + pricing.platformFeeMinor,
  };
};
