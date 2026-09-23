import { randomBytes } from 'node:crypto';
import { encryptDeliveryDetails } from './orders.delivery.js';
import * as repository from './orders.repository.js';

const fail = (code) => Object.assign(new Error(code), { code });
const defaultPricing = { version: 0, platformFeeMinor: 0, deliveryRatePerKmMinor: 60000, currency: 'NGN' };
const reference = () => `SH-${randomBytes(8).toString('hex').toUpperCase()}`;
const distanceKm = (from, to) => {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const latitude = radians(to.latitude - from.latitude);
  const longitude = radians(to.longitude - from.longitude);
  const formula = Math.sin(latitude / 2) ** 2
    + Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(longitude / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(formula), Math.sqrt(1 - formula));
};

const safe = (order) => order && ({
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
});

export const create = async (patientId, data) => {
  const deliveryRequested = data.fulfilments.some((item) => item.fulfilmentMethod === 'DELIVERY');
  const encryptedDeliveryDetails = deliveryRequested ? encryptDeliveryDetails(data.delivery) : null;
  const result = await repository.transaction(async (tx) => {
    if (!await repository.patientRole(tx, patientId)) throw fail('FORBIDDEN');
    const existing = await repository.existing(tx, patientId, data.reservationId, data.idempotencyKey);
    if (existing) return { order: existing, idempotent: true };
    const [reservation, pricing] = await Promise.all([
      repository.reservation(tx, patientId, data.reservationId),
      repository.pricing(tx),
    ]);
    if (!reservation) throw fail('NOT_FOUND');
    const configuration = pricing ?? defaultPricing;
    const byPharmacy = new Map();
    for (const allocation of reservation.allocations) {
      const items = byPharmacy.get(allocation.pharmacyId) ?? [];
      items.push(allocation);
      byPharmacy.set(allocation.pharmacyId, items);
    }
    const selectedIds = data.fulfilments.map((item) => item.pharmacyId);
    if (new Set(selectedIds).size !== selectedIds.length
      || selectedIds.length !== byPharmacy.size
      || selectedIds.some((id) => !byPharmacy.has(id))) throw fail('INVALID');
    if (deliveryRequested && !data.delivery) throw fail('INVALID');
    if (!deliveryRequested && data.delivery) throw fail('INVALID');

    const medicationNames = new Map(reservation.prescription.items.map((item) => [item.id, item.medicationName]));
    const fulfilments = data.fulfilments.map((selection) => {
      const allocations = byPharmacy.get(selection.pharmacyId);
      const pharmacy = allocations[0].pharmacy;
      const canFulfil = selection.fulfilmentMethod === 'PICKUP'
        ? allocations.every((item) => item.quoteItem.pickupAvailable)
        : allocations.every((item) => item.quoteItem.deliveryAvailable);
      const heldInventory = allocations.every((item) => item.inventoryItem?.isActive
        && item.inventoryItem.pharmacyId === pharmacy.id);
      if (!canFulfil || !heldInventory || pharmacy.complianceStatus !== 'VERIFIED') throw fail('INVALID');
      let deliveryFeeMinor = 0;
      if (selection.fulfilmentMethod === 'DELIVERY') {
        if (!Number.isFinite(pharmacy.latitude) || !Number.isFinite(pharmacy.longitude)) throw fail('INVALID');
        deliveryFeeMinor = Math.round(distanceKm(pharmacy, data.delivery.coordinates) * configuration.deliveryRatePerKmMinor);
      }
      const subtotalMinor = allocations.reduce((total, item) => total + item.lineTotalMinor, 0);
      return {
        pharmacyId: pharmacy.id,
        status: 'AWAITING_PAYMENT',
        fulfilmentMethod: selection.fulfilmentMethod,
        subtotalMinor,
        deliveryFeeMinor,
        totalMinor: subtotalMinor + deliveryFeeMinor,
        allocations: {
          create: allocations.map((item) => ({
            reservationAllocationId: item.id,
            inventoryItemId: item.inventoryItemId,
            prescriptionItemId: item.prescriptionItemId,
            medicationName: medicationNames.get(item.prescriptionItemId) ?? (() => { throw fail('INVALID'); })(),
            selectedQuantity: item.selectedQuantity,
            unitPriceMinor: item.unitPriceMinor,
            lineTotalMinor: item.lineTotalMinor,
          })),
        },
      };
    });
    const subtotalMinor = fulfilments.reduce((total, item) => total + item.subtotalMinor, 0);
    const deliveryFeeMinor = fulfilments.reduce((total, item) => total + item.deliveryFeeMinor, 0);
    if (!(await repository.convertReservation(tx, reservation.id, patientId)).count) throw fail('NOT_FOUND');
    const order = await repository.create(tx, {
      reference: reference(),
      patientId,
      reservationId: reservation.id,
      idempotencyKey: data.idempotencyKey,
      status: 'PENDING_PAYMENT',
      currency: configuration.currency,
      pricingConfigVersion: configuration.version,
      platformFeeMinor: configuration.platformFeeMinor,
      deliveryRatePerKmMinor: configuration.deliveryRatePerKmMinor,
      subtotalMinor,
      deliveryFeeMinor,
      totalPayableMinor: subtotalMinor + deliveryFeeMinor + configuration.platformFeeMinor,
      encryptedDeliveryDetails,
      fulfilments: { create: fulfilments },
    });
    await repository.audit(tx, patientId, order.id);
    return { order, idempotent: false };
  });
  return { ...result, order: safe(result.order) };
};

export const detail = async (patientId, orderId) => {
  if (!await repository.isPatient(patientId)) throw fail('FORBIDDEN');
  return safe(await repository.detail(patientId, orderId));
};
export const list = async (patientId) => {
  if (!await repository.isPatient(patientId)) throw fail('FORBIDDEN');
  return (await repository.list(patientId)).map(safe);
};
