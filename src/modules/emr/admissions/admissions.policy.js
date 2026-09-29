// Admission and medication-administration rules — pure functions, no I/O.
import { EmrError } from '../core/errors.js';
import { FREQUENCIES } from '../pharmacy/pharmacy.policy.js';

export const WARD_KINDS = ['GENERAL', 'SURGICAL', 'MATERNITY', 'PAEDIATRIC', 'ICU', 'HDU', 'ISOLATION', 'PRIVATE', 'OTHER'];
export const GENDER_RESTRICTIONS = ['ANY', 'FEMALE', 'MALE'];
export const DISPOSITIONS = ['HOME', 'TRANSFERRED_OUT', 'AGAINST_MEDICAL_ADVICE', 'DECEASED', 'OTHER'];
export const BED_STATUSES = ['AVAILABLE', 'OCCUPIED', 'CLEANING', 'OUT_OF_SERVICE'];

/** A single-sex ward only takes patients recorded as that sex (UNKNOWN/OTHER go to mixed wards). */
export function requireWardAccepts(ward, sex) {
  if (!ward.active) throw new EmrError('INVALID_STATE', { message: `Ward ${ward.code} is not in use.` });
  if (ward.genderRestriction !== 'ANY' && ward.genderRestriction !== sex) {
    throw new EmrError('WARD_RESTRICTED', { message: `Ward ${ward.code} only admits ${ward.genderRestriction.toLowerCase()} patients.` });
  }
}

export function requireBedAvailable(bed) {
  if (bed.status !== 'AVAILABLE') throw new EmrError('BED_NOT_AVAILABLE', { message: `Bed ${bed.code} is ${bed.status.toLowerCase().replace(/_/g, ' ')}.` });
}

// Manual (housekeeping) bed changes. OCCUPIED is only ever set/cleared by admit/transfer/discharge.
const BED_TRANSITIONS = {
  AVAILABLE: ['CLEANING', 'OUT_OF_SERVICE'],
  CLEANING: ['AVAILABLE', 'OUT_OF_SERVICE'],
  OUT_OF_SERVICE: ['AVAILABLE', 'CLEANING'],
  OCCUPIED: [],
};
export function requireBedTransition(bed, next) {
  if (!BED_TRANSITIONS[bed.status].includes(next)) {
    throw new EmrError('INVALID_STATE', {
      message: bed.status === 'OCCUPIED'
        ? `Bed ${bed.code} is occupied; transfer or discharge the patient first.`
        : `Bed ${bed.code} cannot go from ${bed.status.toLowerCase().replace(/_/g, ' ')} to ${next.toLowerCase().replace(/_/g, ' ')}.`,
    });
  }
}

export function requireAdmitted(admission, action) {
  if (admission.status !== 'ADMITTED') {
    throw new EmrError('INVALID_STATE', { message: `This admission is ${admission.status.toLowerCase()} and cannot be ${action}.` });
  }
}

// ---- medication administration guard -------------------------------------------------------
const HOUR = 3_600_000;
// A scheduled dose may not be given sooner than half its nominal interval after (or before) the
// nearest other dose, and no more doses than the frequency allows within a 22-hour window
// (24 h less a 2-hour tolerance, so a daily 08:00 dose charted at 07:50 is not refused).
const COUNT_WINDOW_MS = 22 * HOUR;

const blocked = (rule, message, extra = {}) => new EmrError('ADMINISTRATION_NOT_ALLOWED', { message, details: { rule, ...extra } });

/**
 * Throws ADMINISTRATION_NOT_ALLOWED when giving `dose` at `at` would break the prescription.
 * `given` = the item's other ACTIVE doses with status GIVEN: [{ administeredAt: Date, dose: number }].
 */
export function checkAdministration({ item, maxDailyDose, dose, doseUnit, at, given }) {
  if (doseUnit !== item.doseUnit) throw blocked('DOSE_UNIT', `Chart the dose in ${item.doseUnit}, as prescribed.`);
  if (dose > Number(item.dose)) throw blocked('DOSE_ABOVE_PRESCRIBED', `The prescribed dose is ${Number(item.dose)} ${item.doseUnit}.`, { prescribedDose: Number(item.dose) });

  const time = at.getTime();
  const frequency = FREQUENCIES[item.frequency];
  if (frequency.once) {
    if (given.length) throw blocked('ALREADY_GIVEN', 'This one-off (STAT) dose has already been given.');
    return;
  }
  if (frequency.asNeeded || item.prn) {
    if (maxDailyDose) {
      const lastDay = given.filter((g) => g.administeredAt.getTime() > time - 24 * HOUR && g.administeredAt.getTime() <= time)
        .reduce((sum, g) => sum + g.dose, 0);
      if (lastDay + dose > maxDailyDose) {
        throw blocked('DAILY_MAXIMUM', `This would make ${lastDay + dose} ${item.doseUnit} in 24 hours; the maximum is ${maxDailyDose}.`, { givenLast24h: lastDay, maxDailyDose });
      }
    }
    return;
  }
  const minGap = (24 * HOUR) / frequency.perDay / 2;
  const nearest = given.reduce((closest, g) => {
    const gap = Math.abs(g.administeredAt.getTime() - time);
    return closest === null || gap < closest.gap ? { gap, at: g.administeredAt } : closest;
  }, null);
  if (nearest && nearest.gap < minGap) {
    const nextAllowedAt = new Date(nearest.at.getTime() + minGap);
    throw blocked('TOO_SOON', `A dose was charted at ${nearest.at.toISOString()}; the next may be given from ${nextAllowedAt.toISOString()}.`, { lastGivenAt: nearest.at.toISOString(), nextAllowedAt: nextAllowedAt.toISOString() });
  }
  if (frequency.perDay >= 1) {
    const inWindow = given.filter((g) => g.administeredAt.getTime() > time - COUNT_WINDOW_MS && g.administeredAt.getTime() <= time).length;
    if (inWindow >= Math.ceil(frequency.perDay)) {
      throw blocked('DAILY_COUNT', `${item.frequency} allows ${Math.ceil(frequency.perDay)} doses a day and ${inWindow} are already charted.`, { dosesInWindow: inWindow });
    }
  }
}

/** When the next scheduled dose may be given (for the MAR view); null for PRN/STAT. */
export function nextAllowedAt(item, lastGivenAt) {
  const frequency = FREQUENCIES[item.frequency];
  if (!lastGivenAt || frequency.once || frequency.asNeeded || item.prn) return null;
  return new Date(lastGivenAt.getTime() + (24 * HOUR) / frequency.perDay / 2);
}
