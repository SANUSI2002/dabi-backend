import { randomBytes } from "node:crypto";
import { encryptDeliveryDetails } from "./orders.delivery.js";
import * as repository from "./orders.repository.js";
import { commissionSnapshot } from "../pharmacies/portal.policy.js";

const fail = (code) => Object.assign(new Error(code), { code });
const defaultPricing = {
  version: 0,
  platformFeeMinor: 0,
  deliveryRatePerKmMinor: 60000,
  currency: "NGN",
};
const reference = () => `SH-${randomBytes(8).toString("hex").toUpperCase()}`;
const distanceKm = (from, to) => {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const latitude = radians(to.latitude - from.latitude);
  const longitude = radians(to.longitude - from.longitude);
  const formula =
    Math.sin(latitude / 2) ** 2 +
    Math.cos(radians(from.latitude)) *
      Math.cos(radians(to.latitude)) *
      Math.sin(longitude / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(formula), Math.sqrt(1 - formula));
};

const safe = (order) =>
  order && {
    id: order.id,
    reference: order.reference,
    status: order.status,
    reservationId: order.reservationId,
    currency: order.currency,
    pricingConfigVersion: order.pricingConfigVersion,
    platformFeeMinor: order.platformFeeMinor,
    deliveryRatePerKmMinor: order.deliveryRatePerKmMinor,
    subtotalMinor: order.subtotalMinor,
    deliveryFeeMinor: order.deliveryFeeMinor,
    totalPayableMinor: order.totalPayableMinor,
    deliveryDetailsPresent: Boolean(order.encryptedDeliveryDetails),
    createdAt: order.createdAt,
    fulfilments: order.fulfilments?.map((fulfilment) => ({
      id: fulfilment.id,
      status: fulfilment.status,
      fulfilmentMethod: fulfilment.fulfilmentMethod,
      pharmacy: fulfilment.pharmacy,
      subtotalMinor: fulfilment.subtotalMinor,
      deliveryFeeMinor: fulfilment.deliveryFeeMinor,
      totalMinor: fulfilment.totalMinor,
      allocations: fulfilment.allocations?.map((allocation) => ({
        prescriptionItemId: allocation.prescriptionItemId,
        medicationName: allocation.medicationName,
        selectedQuantity: allocation.selectedQuantity,
        unitPriceMinor: allocation.unitPriceMinor,
        lineTotalMinor: allocation.lineTotalMinor,
      })),
    })),
  };

export const create = async (patientId, data) => {
  const deliveryRequested = data.fulfilments.some(
    (item) => item.fulfilmentMethod === "DELIVERY",
  );
  const encryptedDeliveryDetails = deliveryRequested
    ? encryptDeliveryDetails(data.delivery)
    : null;
  const result = await repository.transaction(async (tx) => {
    if (!(await repository.patientRole(tx, patientId))) throw fail("FORBIDDEN");
    const existing = await repository.existing(
      tx,
      patientId,
      data.reservationId,
      data.idempotencyKey,
    );
    if (existing) return { order: existing, idempotent: true };
    const [reservation, pricing] = await Promise.all([
      repository.reservation(tx, patientId, data.reservationId),
      repository.pricing(tx),
    ]);
    if (!reservation) throw fail("NOT_FOUND");
    const configuration = pricing ?? defaultPricing;
    const byPharmacy = new Map();
    for (const allocation of reservation.allocations) {
      const items = byPharmacy.get(allocation.pharmacyId) ?? [];
      items.push(allocation);
      byPharmacy.set(allocation.pharmacyId, items);
    }
    const selectedIds = data.fulfilments.map((item) => item.pharmacyId);
    if (
      new Set(selectedIds).size !== selectedIds.length ||
      selectedIds.length !== byPharmacy.size ||
      selectedIds.some((id) => !byPharmacy.has(id))
    )
      throw fail("INVALID");
    if (deliveryRequested && !data.delivery) throw fail("INVALID");
    if (!deliveryRequested && data.delivery) throw fail("INVALID");

    const medicationNames = new Map(
      (reservation.prescription?.items ?? []).map((item) => [
        item.id,
        item.medicationName,
      ]),
    );
    const fulfilments = data.fulfilments.map((selection) => {
      const allocations = byPharmacy.get(selection.pharmacyId);
      const pharmacy = allocations[0].pharmacy;
      const canFulfil =
        reservation.kind === "MARKETPLACE"
          ? Boolean(
              pharmacy.tier &&
              (selection.fulfilmentMethod === "PICKUP"
                ? pharmacy.tier.pickupEnabled
                : pharmacy.tier.deliveryEnabled),
            )
          : selection.fulfilmentMethod === "PICKUP"
            ? allocations.every((item) => item.quoteItem.pickupAvailable)
            : allocations.every((item) => item.quoteItem.deliveryAvailable);
      const heldInventory = allocations.every(
        (item) =>
          item.inventoryItem?.isActive &&
          item.inventoryItem.pharmacyId === pharmacy.id,
      );
      if (
        !canFulfil ||
        !heldInventory ||
        pharmacy.complianceStatus !== "VERIFIED"
      )
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
          pharmacy.admin?.accountStatus !== "ACTIVE" ||
          !pharmacy.admin?.emailVerifiedAt ||
          !pharmacy.superintendentLicenceExpiresAt ||
          new Date(pharmacy.superintendentLicenceExpiresAt) <= new Date() ||
          !branch ||
          branch.status !== "VERIFIED" ||
          new Date(branch.licenceExpiresAt) <= new Date() ||
          allocations.some((a) => a.inventoryItem.branch?.id !== branch.id))
      )
        throw fail("INVALID");
      if (
        reservation.kind === "MARKETPLACE" &&
        allocations.some(
          (a) =>
            a.inventoryItem.listing?.status !== "PUBLISHED" ||
            !a.inventoryItem.listing?.imageHash ||
            a.inventoryItem.listing.productClass === "PRESCRIPTION_ONLY",
        )
      )
        throw fail("INVALID");
      if (
        tier &&
        (selection.fulfilmentMethod === "DELIVERY"
          ? !tier.deliveryEnabled
          : !tier.pickupEnabled)
      )
        throw fail("INVALID");
      let deliveryFeeMinor = 0;
      if (selection.fulfilmentMethod === "DELIVERY") {
        const origin = tier ? branch : pharmacy;
        if (
          !Number.isFinite(origin.latitude) ||
          !Number.isFinite(origin.longitude)
        )
          throw fail("INVALID");
        const distance = distanceKm(origin, data.delivery.coordinates);
        if (tier && distance > tier.deliveryRadiusKm) throw fail("INVALID");
        deliveryFeeMinor = Math.round(
          distance * configuration.deliveryRatePerKmMinor,
        );
      }
      const subtotalMinor = allocations.reduce(
        (total, item) => total + item.lineTotalMinor,
        0,
      );
      if (tier && subtotalMinor < tier.minimumOrderMinor) throw fail("INVALID");
      return {
        pharmacyId: pharmacy.id,
        status: "AWAITING_PAYMENT",
        fulfilmentMethod: selection.fulfilmentMethod,
        subtotalMinor,
        deliveryFeeMinor,
        totalMinor: subtotalMinor + deliveryFeeMinor,
        ...(tier ? commissionSnapshot(tier, subtotalMinor) : {}),
        allocations: {
          create: allocations.map((item) => ({
            reservationAllocationId: item.id,
            inventoryItemId: item.inventoryItemId,
            prescriptionItemId: item.prescriptionItemId,
            medicationName:
              (reservation.kind === "MARKETPLACE"
                ? item.inventoryItem.medicationName
                : medicationNames.get(item.prescriptionItemId)) ??
              (() => {
                throw fail("INVALID");
              })(),
            selectedQuantity: item.selectedQuantity,
            unitPriceMinor: item.unitPriceMinor,
            lineTotalMinor: item.lineTotalMinor,
          })),
        },
      };
    });
    const subtotalMinor = fulfilments.reduce(
      (total, item) => total + item.subtotalMinor,
      0,
    );
    const deliveryFeeMinor = fulfilments.reduce(
      (total, item) => total + item.deliveryFeeMinor,
      0,
    );
    if (
      !(await repository.convertReservation(tx, reservation.id, patientId))
        .count
    )
      throw fail("NOT_FOUND");
    const order = await repository.create(tx, {
      reference: reference(),
      patientId,
      reservationId: reservation.id,
      idempotencyKey: data.idempotencyKey,
      status: "PENDING_PAYMENT",
      currency: configuration.currency,
      pricingConfigVersion: configuration.version,
      platformFeeMinor: configuration.platformFeeMinor,
      deliveryRatePerKmMinor: configuration.deliveryRatePerKmMinor,
      subtotalMinor,
      deliveryFeeMinor,
      totalPayableMinor:
        subtotalMinor + deliveryFeeMinor + configuration.platformFeeMinor,
      encryptedDeliveryDetails,
      fulfilments: { create: fulfilments },
    });
    await repository.audit(tx, patientId, order.id);
    return { order, idempotent: false };
  });
  return { ...result, order: safe(result.order) };
};

export const detail = async (patientId, orderId) => {
  if (!(await repository.isPatient(patientId))) throw fail("FORBIDDEN");
  return safe(await repository.detail(patientId, orderId));
};
export const list = async (patientId) => {
  if (!(await repository.isPatient(patientId))) throw fail("FORBIDDEN");
  return (await repository.list(patientId)).map(safe);
};
