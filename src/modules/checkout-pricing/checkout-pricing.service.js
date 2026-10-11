import * as repository from "./checkout-pricing.repository.js";
import {
  activeConfiguration,
  canManagePricing,
  createConfiguration,
  quoteDelivery,
} from "./pricing-configurations.js";

const fail = (code, message, details) =>
  Object.assign(new Error(code), { code, message: message ?? code, details });

const publicConfiguration = (config) => ({
  version: config.version,
  effectiveAt: config.effectiveAt,
  platformFeeMinor: config.platformFeeMinor,
  deliveryRatePerKmMinor: config.deliveryRatePerKmMinor,
  currency: config.currency,
});

export const readConfiguration = async (userId) => {
  if (!(await canManagePricing(userId))) throw fail("FORBIDDEN");
  return activeConfiguration();
};

/** Legacy endpoint: changes the rate and platform fee only, carrying every other rule forward. */
export const updateConfiguration = async (userId, values) => {
  if (!(await canManagePricing(userId))) throw fail("FORBIDDEN");
  const { after } = await repository.transaction((tx) =>
    createConfiguration(tx, userId, values, {
      reason: "Rate or platform fee changed through the checkout pricing endpoint",
    }),
  );
  return after;
};

/**
 * Whether each selected pharmacy may serve the chosen fulfilment method — the same rules order
 * creation enforces. Throws INVALID when not.
 */
function checkEligibility(reservation, allocations, selection, subtotalMinor) {
  const pharmacy = allocations[0].pharmacy;
  const supportsMethod =
    reservation.kind === "MARKETPLACE"
      ? Boolean(
          pharmacy.tier &&
          (selection.fulfilmentMethod === "PICKUP"
            ? pharmacy.tier.pickupEnabled
            : pharmacy.tier.deliveryEnabled),
        )
      : selection.fulfilmentMethod === "PICKUP"
        ? allocations.every((allocation) => allocation.quoteItem.pickupAvailable)
        : allocations.every((allocation) => allocation.quoteItem.deliveryAvailable);
  if (!supportsMethod || pharmacy.complianceStatus !== "VERIFIED") throw fail("INVALID");
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
      (selection.fulfilmentMethod === "PICKUP" ? !tier.pickupEnabled : !tier.deliveryEnabled))
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
  return { pharmacy, tier, branch };
}

export const preview = async (patientId, reservationId, selections, deliveryCoordinates) => {
  if (!(await repository.isPatient(patientId))) throw fail("FORBIDDEN");
  const now = new Date();
  const [pricing, reservation] = await Promise.all([
    activeConfiguration(),
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
  if (selections.some((s) => s.fulfilmentMethod === "DELIVERY") && !deliveryCoordinates) throw fail("INVALID");

  const pharmacies = [];
  for (const selection of selections) {
    const allocations = byPharmacy.get(selection.pharmacyId);
    const subtotalMinor = allocations.reduce((total, allocation) => total + allocation.lineTotalMinor, 0);
    const { pharmacy, tier, branch } = checkEligibility(reservation, allocations, selection, subtotalMinor);
    let deliveryQuote = null;
    if (selection.fulfilmentMethod === "DELIVERY") {
      const origin = tier ? branch : pharmacy;
      deliveryQuote = await quoteDelivery({
        config: pricing,
        origin: { latitude: origin.latitude, longitude: origin.longitude },
        destination: deliveryCoordinates,
        subtotalMinor,
        tierRadiusKm: tier ? tier.deliveryRadiusKm : null,
        now,
      });
    }
    const deliveryFeeMinor = deliveryQuote?.feeMinor ?? 0;
    pharmacies.push({
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
      distanceKm: deliveryQuote ? deliveryQuote.distanceKm : null,
      distanceMethod: deliveryQuote?.method ?? null,
      deliveryBreakdown: deliveryQuote?.lines ?? [],
      deliveryQuote,
      totalMinor: subtotalMinor + deliveryFeeMinor,
    });
  }

  const subtotalMinor = pharmacies.reduce((total, p) => total + p.subtotalMinor, 0);
  const deliveryFeeMinor = pharmacies.reduce((total, p) => total + p.deliveryFeeMinor, 0);
  const ttlExpiry = new Date(now.getTime() + pricing.quoteTtlMinutes * 60_000);
  const reservationExpiry = new Date(reservation.expiresAt);
  return {
    reservationId: reservation.id,
    reservationExpiresAt: reservation.expiresAt,
    currency: pricing.currency,
    pricingConfiguration: publicConfiguration(pricing),
    quote: {
      pricingVersion: pricing.version,
      quotedAt: now.toISOString(),
      // Order creation recalculates; if the price changed, it refuses with PRICE_CHANGED and the new total.
      expiresAt: (ttlExpiry < reservationExpiry ? ttlExpiry : reservationExpiry).toISOString(),
    },
    pharmacies,
    subtotalMinor,
    deliveryFeeMinor,
    platformFeeMinor: pricing.platformFeeMinor,
    totalPayableMinor: subtotalMinor + deliveryFeeMinor + pricing.platformFeeMinor,
  };
};
