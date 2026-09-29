// Prescribing and dispensing rules — pure functions, no I/O.
import { EmrError } from '../core/errors.js';

// Administrations per day. STAT = once; PRN = as needed (no fixed daily count).
export const FREQUENCIES = {
  OD: { perDay: 1 }, MANE: { perDay: 1 }, NOCTE: { perDay: 1 }, BD: { perDay: 2 }, TDS: { perDay: 3 }, QDS: { perDay: 4 },
  Q4H: { perDay: 6 }, Q6H: { perDay: 4 }, Q8H: { perDay: 3 }, Q12H: { perDay: 2 }, WEEKLY: { perDay: 1 / 7 },
  STAT: { once: true }, PRN: { asNeeded: true },
};

export const CONTROLLED_MAX_DAYS = 30;
export const ADJUSTMENT_REASONS = ['COUNT_CORRECTION', 'DAMAGED', 'EXPIRED', 'LOST', 'OTHER'];
const num = (value) => (value === null || value === undefined ? null : Number(value));
// Round up, ignoring floating-point noise (1.5 × 2 must be 3, not 4).
const ceilUnits = (value) => Math.ceil(value - 1e-9);

/**
 * Validates one prescribed line against its formulary item and returns the fields to store.
 * Units must match the formulary's dose unit exactly — no silent mg/g conversions.
 */
export function prepareLine(line, drug) {
  const problems = [];
  const field = (name, message) => problems.push({ field: `${drug.code}.${name}`, message });
  const frequency = FREQUENCIES[line.frequency];
  if (line.doseUnit !== drug.doseUnit) field('doseUnit', `must be ${drug.doseUnit} for ${drug.genericName}`);
  const prn = line.frequency === 'PRN' || line.prn === true;
  if (prn && !line.prnReason) field('prnReason', 'is required for as-needed medicines');
  if (!frequency.once && !prn && !line.durationDays) field('durationDays', 'is required for regular medicines');
  if (drug.controlled && line.durationDays && line.durationDays > CONTROLLED_MAX_DAYS) field('durationDays', `controlled medicines are limited to ${CONTROLLED_MAX_DAYS} days`);
  if (drug.controlled && prn && !line.quantity) field('quantity', 'must be stated for as-needed controlled medicines');

  let quantity = line.quantity;
  const perUnit = num(drug.dosePerDispenseUnit);
  if (!quantity) {
    if (!perUnit) field('quantity', `is required (${drug.genericName} cannot be counted from the dose)`);
    else if (frequency.once) quantity = ceilUnits(line.dose / perUnit);
    else if (!prn && line.durationDays) quantity = ceilUnits((line.dose / perUnit) * frequency.perDay * line.durationDays);
    else field('quantity', 'is required for as-needed medicines');
  }
  if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000)) field('quantity', 'must be a whole number between 1 and 10000');
  if (problems.length) throw new EmrError('VALIDATION_FAILED', { details: problems });

  return {
    formularyItemId: drug.id, drugCode: drug.code, drugName: drug.genericName, strength: drug.strength, form: drug.form,
    dose: line.dose, doseUnit: drug.doseUnit, frequency: line.frequency, route: line.route ?? drug.defaultRoute,
    durationDays: line.durationDays ?? null, prn, prnReason: prn ? line.prnReason : null, instructions: line.instructions ?? null,
    dispenseUnit: drug.dispenseUnit, quantityPrescribed: quantity, controlled: drug.controlled,
  };
}

/** Largest amount given in one day, or null when it cannot be known (as-needed). */
export function dailyDose(dose, frequencyCode) {
  const frequency = FREQUENCIES[frequencyCode];
  if (frequency.asNeeded) return null;
  if (frequency.once) return dose;
  return frequency.perDay >= 1 ? dose * frequency.perDay : dose;
}

/**
 * Clinical decision support. Returns alerts; HIGH alerts must be overridden with a reason.
 *   ALLERGY            HIGH      drug code or one of its classes matches an active allergy
 *   MAX_DOSE           HIGH      daily (or single) dose above the formulary maximum
 *   DUPLICATE_THERAPY  HIGH      same drug already active for the patient
 *   DUPLICATE_CLASS    MODERATE  another active drug of the same class
 *   CONTROLLED/HIGH_ALERT INFO   handling notices for the pharmacist
 */
export function safetyAlerts({ lines, drugs, allergies, activeItems }) {
  const alerts = [];
  const add = (drug, type, severity, message) => alerts.push({ drugCode: drug.code, type, severity, message });
  for (const line of lines) {
    const drug = drugs.find((d) => d.id === line.formularyItemId);
    const markers = new Set([drug.code, ...drug.drugClasses]);
    for (const allergy of allergies) {
      if (markers.has(allergy.substanceCode)) {
        add(drug, 'ALLERGY', 'HIGH', `Patient has a recorded ${allergy.severity.toLowerCase()} allergy to ${allergy.substance}${allergy.reaction ? ` (${allergy.reaction})` : ''}.`);
      }
    }
    const max = num(drug.maxDailyDose);
    const daily = dailyDose(line.dose, line.frequency);
    if (max && ((daily !== null && daily > max) || line.dose > max)) {
      add(drug, 'MAX_DOSE', 'HIGH', `${daily ?? line.dose} ${drug.doseUnit}/day exceeds the maximum of ${max} ${drug.doseUnit}/day.`);
    }
    const others = activeItems.filter((a) => a.formularyItemId === drug.id);
    if (others.length) add(drug, 'DUPLICATE_THERAPY', 'HIGH', `${drug.genericName} is already prescribed and active for this patient.`);
    const sameClass = activeItems.filter((a) => a.formularyItemId !== drug.id && a.drugClasses.some((c) => drug.drugClasses.includes(c)));
    for (const other of sameClass) {
      const shared = other.drugClasses.filter((c) => drug.drugClasses.includes(c)).join(', ');
      add(drug, 'DUPLICATE_CLASS', 'MODERATE', `${other.drugName} (${shared}) is already active for this patient.`);
    }
    if (drug.controlled) add(drug, 'CONTROLLED', 'INFO', 'Controlled medicine: dispensing requires a witness.');
    if (drug.highAlert) add(drug, 'HIGH_ALERT', 'INFO', 'High-alert medicine: double-check dose and route.');
  }
  // Same drug within this prescription is a validation error, handled before this point.
  return alerts;
}

/** Attaches override reasons; every HIGH alert needs one, otherwise SAFETY_CHECK_REQUIRED. */
export function applyOverrides(alerts, overrides = []) {
  const unresolved = [];
  const annotated = alerts.map((alert) => {
    if (alert.severity !== 'HIGH') return alert;
    const override = overrides.find((o) => o.drugCode === alert.drugCode && o.type === alert.type);
    if (!override) { unresolved.push(alert); return alert; }
    return { ...alert, overrideReason: override.reason };
  });
  if (unresolved.length) {
    throw new EmrError('SAFETY_CHECK_REQUIRED', {
      message: 'Safety checks need your attention: resend with an override reason for each alert, or change the prescription.',
      details: unresolved,
    });
  }
  return annotated;
}

// ---- lifecycle ----
export const DISPENSABLE = ['APPROVED', 'PARTIALLY_DISPENSED'];
export const CANCELLABLE = ['PENDING_REVIEW', 'APPROVED', 'PARTIALLY_DISPENSED'];

export function requirePrescriptionStatus(prescription, allowed, action) {
  if (!allowed.includes(prescription.status)) {
    throw new EmrError('INVALID_STATE', { message: `A prescription that is ${prescription.status.toLowerCase().replace(/_/g, ' ')} cannot be ${action}.` });
  }
}

export const itemStatusFor = (item) => {
  if (item.status === 'CANCELLED') return 'CANCELLED';
  return item.quantityDispensed >= item.quantityPrescribed ? 'COMPLETED' : 'ACTIVE';
};

/** Status after a dispense or return, from the items' dispensed quantities. */
export function prescriptionStatusFor(items) {
  const live = items.filter((i) => i.status !== 'CANCELLED');
  const anyDispensed = items.some((i) => i.quantityDispensed > 0);
  if (live.length && live.every((i) => i.quantityDispensed >= i.quantityPrescribed)) return 'DISPENSED';
  return anyDispensed ? 'PARTIALLY_DISPENSED' : 'APPROVED';
}

/**
 * First-expiry-first-out allocation over batches that are already locked and sorted by expiry.
 * Expired batches (expiry on or before today) are never used. Returns the per-batch quantities,
 * or throws INSUFFICIENT_STOCK stating what is available.
 */
export function allocateFefo(batches, quantity, today, drugCode) {
  const usable = batches.filter((b) => b.quantityOnHand > 0 && toDateString(b.expiryDate) > today);
  const available = usable.reduce((sum, b) => sum + b.quantityOnHand, 0);
  if (available < quantity) {
    throw new EmrError('INSUFFICIENT_STOCK', { message: `Only ${available} in date for ${drugCode}; ${quantity} requested.`, details: [{ drugCode, requested: quantity, available }] });
  }
  const picks = [];
  let remaining = quantity;
  for (const batch of usable) {
    if (!remaining) break;
    const take = Math.min(batch.quantityOnHand, remaining);
    picks.push({ batch, quantity: take });
    remaining -= take;
  }
  return picks;
}

export const toDateString = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

// ---- "current" medicines (medication list + duplicate-therapy checks) ----
// A course is current until its stated duration ends; a one-off (STAT) for a day; an as-needed
// medicine without a duration for 30 days. Fully dispensed courses are still being taken, so they
// count; cancelled lines and rejected/cancelled prescriptions do not.
const DAY_MS = 86_400_000;
export const CURRENT_PRESCRIPTION_STATUSES = ['PENDING_REVIEW', 'APPROVED', 'PARTIALLY_DISPENSED', 'DISPENSED'];
export function courseEnd(item) {
  const start = new Date(item.createdAt).getTime();
  if (item.durationDays) return start + item.durationDays * DAY_MS;
  if (item.frequency === 'STAT') return start + DAY_MS;
  return start + 30 * DAY_MS;
}
export const isCurrent = (item, now = Date.now()) => item.status !== 'CANCELLED' && courseEnd(item) > now;
