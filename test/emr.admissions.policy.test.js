// Pure admission and medication-administration rules (no database).
import { describe, expect, it } from 'vitest';
import { checkAdministration, nextAllowedAt, requireBedTransition, requireWardAccepts } from '../src/modules/emr/admissions/admissions.policy.js';

const HOUR = 3_600_000;
const base = new Date('2026-10-02T08:00:00Z');
const at = (hours) => new Date(base.getTime() + hours * HOUR);
const rule = (fn) => { try { fn(); return null; } catch (error) { return error.details?.rule ?? error.code; } };
const item = (frequency, extra = {}) => ({ dose: 1000, doseUnit: 'mg', frequency, prn: frequency === 'PRN', ...extra });
const check = (frequency, when, givenHours, extra = {}) => rule(() => checkAdministration({
  item: item(frequency), maxDailyDose: extra.maxDailyDose ?? null, dose: extra.dose ?? 1000, doseUnit: extra.doseUnit ?? 'mg', at: at(when),
  given: givenHours.map((h) => ({ administeredAt: at(h), dose: extra.givenDose ?? 1000 })),
}));

describe('scheduled doses', () => {
  it('allows the next daily dose charted a little early, but not a double dose', () => {
    expect(check('OD', 23 + 50 / 60, [0])).toBeNull(); // 08:00 then 07:50 next day
    expect(check('OD', 2, [0])).toBe('TOO_SOON');
  });

  it('keeps half the nominal interval between doses, before or after (late charting)', () => {
    expect(check('TDS', 3.9, [0])).toBe('TOO_SOON');
    expect(check('TDS', 4, [0])).toBeNull();
    expect(check('TDS', -2, [0])).toBe('TOO_SOON'); // charting back in time next to an existing dose
  });

  it('caps the number of doses in a day', () => {
    expect(check('QDS', 18, [0, 5, 10, 15 - 24])).toBeNull(); // only 3 in the last 22 h
    expect(check('QDS', 21, [0, 5, 10, 15])).toBe('DAILY_COUNT');
  });

  it('spaces weekly doses by half a week', () => {
    expect(check('WEEKLY', 72, [0])).toBe('TOO_SOON');
    expect(check('WEEKLY', 84, [0])).toBeNull();
  });
});

describe('one-off and as-needed doses', () => {
  it('gives a STAT dose once only', () => {
    expect(check('STAT', 0, [])).toBeNull();
    expect(check('STAT', 10, [0])).toBe('ALREADY_GIVEN');
  });

  it('keeps as-needed doses within the formulary daily maximum over any 24 hours', () => {
    expect(check('PRN', 10, [0, 2, 4], { maxDailyDose: 4000 })).toBeNull();
    expect(check('PRN', 10, [0, 2, 4, 6], { maxDailyDose: 4000 })).toBe('DAILY_MAXIMUM');
    expect(check('PRN', 25, [0, 2, 4, 6], { maxDailyDose: 4000 })).toBeNull(); // the 08:00 dose has left the window
    expect(check('PRN', 1, [0], { maxDailyDose: null })).toBeNull();
  });
});

describe('dose checks', () => {
  it('requires the prescribed unit and at most the prescribed dose', () => {
    expect(check('OD', 0, [], { doseUnit: 'g', dose: 1 })).toBe('DOSE_UNIT');
    expect(check('OD', 0, [], { dose: 1500 })).toBe('DOSE_ABOVE_PRESCRIBED');
    expect(check('OD', 0, [], { dose: 500 })).toBeNull(); // a reduced dose is allowed
  });

  it('reports when the next scheduled dose is allowed', () => {
    expect(nextAllowedAt(item('BD'), base).toISOString()).toBe(at(6).toISOString());
    expect(nextAllowedAt(item('PRN'), base)).toBeNull();
    expect(nextAllowedAt(item('BD'), null)).toBeNull();
  });
});

describe('beds and wards', () => {
  const code = (fn) => { try { fn(); return null; } catch (error) { return error.code; } };
  it('only lets housekeeping move beds that are not occupied', () => {
    expect(code(() => requireBedTransition({ code: 'B1', status: 'CLEANING' }, 'AVAILABLE'))).toBeNull();
    expect(code(() => requireBedTransition({ code: 'B1', status: 'OCCUPIED' }, 'CLEANING'))).toBe('INVALID_STATE');
    expect(code(() => requireBedTransition({ code: 'B1', status: 'AVAILABLE' }, 'AVAILABLE'))).toBe('INVALID_STATE');
  });

  it('enforces single-sex and inactive wards', () => {
    const ward = { code: 'W', active: true, genderRestriction: 'FEMALE' };
    expect(code(() => requireWardAccepts(ward, 'FEMALE'))).toBeNull();
    expect(code(() => requireWardAccepts(ward, 'UNKNOWN'))).toBe('WARD_RESTRICTED');
    expect(code(() => requireWardAccepts({ ...ward, genderRestriction: 'ANY' }, 'MALE'))).toBeNull();
    expect(code(() => requireWardAccepts({ ...ward, active: false }, 'FEMALE'))).toBe('INVALID_STATE');
  });
});
