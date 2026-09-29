// Billing rules — pure functions, no I/O. All money is integer minor units (kobo), computed with
// BigInt so no amount is ever rounded by floating point. The database re-checks the same
// arithmetic (see migration 20261003090000_emr_billing), so the two must agree exactly.
import { EmrError } from '../core/errors.js';

const DAY_MS = 86_400_000;

/** Tax on an amount at a basis-point rate, rounded half away from zero (as Postgres ROUND does). */
export function taxFor(amountMinor, taxRateBp) {
  const amount = BigInt(amountMinor);
  const sign = amount < 0n ? -1n : 1n;
  const magnitude = amount * sign;
  return sign * ((magnitude * BigInt(taxRateBp) * 2n + 10_000n) / 20_000n);
}

export function lineAmounts(quantity, unitPriceMinor, taxRateBp) {
  const amountMinor = BigInt(quantity) * BigInt(unitPriceMinor);
  return { amountMinor, taxMinor: taxFor(amountMinor, taxRateBp) };
}

/** Invoice totals from its charges; the discount may not exceed what is owed. */
export function invoiceTotals(charges, discountMinor = 0n) {
  const subtotal = charges.reduce((sum, c) => sum + BigInt(c.amountMinor), 0n);
  const tax = charges.reduce((sum, c) => sum + BigInt(c.taxMinor), 0n);
  const discount = BigInt(discountMinor);
  if (subtotal < 0n || tax < 0n) {
    throw new EmrError('INVALID_STATE', { message: 'Credits exceed the charges waiting to be invoiced; they will be settled against later charges.' });
  }
  if (discount > subtotal + tax) throw new EmrError('VALIDATION_FAILED', { message: 'The discount cannot exceed the amount owed.' });
  return { subtotalMinor: subtotal, taxMinor: tax, discountMinor: discount, totalMinor: subtotal + tax - discount };
}

export function invoiceStatusFor(totalMinor, amountPaidMinor) {
  const total = BigInt(totalMinor);
  const paid = BigInt(amountPaidMinor);
  if (paid === 0n) return total === 0n ? 'PAID' : 'ISSUED';
  return paid >= total ? 'PAID' : 'PARTIALLY_PAID';
}

/** BigInt → JSON number, refusing anything that would lose precision. */
export function money(value) {
  if (value === null || value === undefined) return value;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Amount ${value} exceeds the safe integer range`);
  return number;
}

// ---- bed-days -------------------------------------------------------------------------------
const dateOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function wardAt(assignments, at) {
  const covering = assignments.find((a) => a.startedAt.getTime() <= at && (!a.endedAt || a.endedAt.getTime() > at));
  if (covering) return covering.wardId;
  const earlier = assignments.filter((a) => a.startedAt.getTime() <= at).sort((a, b) => b.startedAt - a.startedAt);
  return (earlier[0] ?? assignments[0]).wardId;
}

/**
 * One bed-day per midnight (UTC) spent admitted, charged at the ward occupied just before that
 * midnight; a stay discharged without crossing midnight is one (day-case) bed-day. Days are keyed
 * by the night's date, so re-running capture never charges a night twice.
 */
export function bedDays({ admission, assignments, now = new Date() }) {
  if (admission.status === 'CANCELLED' || !assignments.length) return [];
  const start = admission.admittedAt.getTime();
  const end = (admission.dischargedAt ?? now).getTime();
  const days = [];
  for (let midnight = Math.floor(start / DAY_MS) * DAY_MS + DAY_MS; midnight <= end; midnight += DAY_MS) {
    days.push({ date: dateOf(midnight - DAY_MS), wardId: wardAt(assignments, midnight - 1) });
  }
  if (!days.length && admission.status === 'DISCHARGED') days.push({ date: dateOf(start), wardId: wardAt(assignments, start) });
  return days;
}

/** Credit still owed for medicine returned after its dispense line was charged. */
export function returnCreditDue(quantityReturned, alreadyCredited) {
  return Math.max(0, quantityReturned - alreadyCredited);
}
