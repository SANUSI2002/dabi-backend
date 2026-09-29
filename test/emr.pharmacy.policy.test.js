// Pure prescribing/dispensing rules (no database).
import { describe, expect, it } from 'vitest';
import {
  allocateFefo, applyOverrides, courseEnd, dailyDose, isCurrent, itemStatusFor, prepareLine, prescriptionStatusFor, safetyAlerts,
} from '../src/modules/emr/pharmacy/pharmacy.policy.js';
import { DEFAULT_FORMULARY } from '../src/modules/emr/pharmacy/formulary.catalog.js';

const drug = (code) => ({ id: `id-${code}`, ...DEFAULT_FORMULARY.find((d) => d.code === code) });
const code = (fn) => { try { fn(); return null; } catch (error) { return error.code; } };
const line = (drugCode, extra) => prepareLine({ drugCode, ...extra }, drug(drugCode));

describe('prepareLine', () => {
  it('computes whole-unit quantities without floating-point surprises', () => {
    expect(line('PARA500', { dose: 1000, doseUnit: 'mg', frequency: 'TDS', durationDays: 5 }).quantityPrescribed).toBe(30);
    expect(line('PARA500', { dose: 750, doseUnit: 'mg', frequency: 'BD', durationDays: 1 }).quantityPrescribed).toBe(3); // 1.5 × 2
    expect(line('AMOX500', { dose: 250, doseUnit: 'mg', frequency: 'TDS', durationDays: 5 }).quantityPrescribed).toBe(8); // 7.5 → 8
    expect(line('CEFTRI1G_INJ', { dose: 2, doseUnit: 'g', frequency: 'STAT' }).quantityPrescribed).toBe(2);
    expect(line('AMLO5', { dose: 5, doseUnit: 'mg', frequency: 'WEEKLY', durationDays: 28 }).quantityPrescribed).toBe(4);
  });

  it('requires the formulary dose unit, a duration for regular courses, and a quantity when it cannot be counted', () => {
    expect(code(() => line('PARA500', { dose: 1, doseUnit: 'g', frequency: 'OD', durationDays: 1 }))).toBe('VALIDATION_FAILED');
    expect(code(() => line('PARA500', { dose: 500, doseUnit: 'mg', frequency: 'TDS' }))).toBe('VALIDATION_FAILED');
    expect(code(() => line('SALB_INH', { dose: 2, doseUnit: 'puff', frequency: 'QDS', durationDays: 5 }))).toBe('VALIDATION_FAILED');
    expect(line('SALB_INH', { dose: 2, doseUnit: 'puff', frequency: 'PRN', prnReason: 'Wheeze', quantity: 1 })).toMatchObject({ prn: true, quantityPrescribed: 1 });
    expect(code(() => line('ORS', { dose: 1, doseUnit: 'sachet', frequency: 'PRN', quantity: 5 }))).toBe('VALIDATION_FAILED'); // no PRN reason
  });

  it('limits controlled medicines to 30 days and a stated as-needed quantity', () => {
    expect(code(() => line('TRAM50', { dose: 50, doseUnit: 'mg', frequency: 'BD', durationDays: 31 }))).toBe('VALIDATION_FAILED');
    expect(code(() => line('TRAM50', { dose: 50, doseUnit: 'mg', frequency: 'PRN', prnReason: 'Pain' }))).toBe('VALIDATION_FAILED');
    expect(line('TRAM50', { dose: 50, doseUnit: 'mg', frequency: 'BD', durationDays: 30 })).toMatchObject({ controlled: true, quantityPrescribed: 60 });
  });
});

describe('safety checks', () => {
  const lineFor = (drugCode, dose, frequency) => ({ formularyItemId: `id-${drugCode}`, drugCode, dose, frequency });
  const drugs = DEFAULT_FORMULARY.map((d) => ({ id: `id-${d.code}`, ...d }));

  it('matches allergies by drug code or drug class', () => {
    const allergies = [{ substance: 'Penicillin', substanceCode: 'PENICILLIN', severity: 'SEVERE', reaction: 'Rash' }];
    const alerts = safetyAlerts({ lines: [lineFor('AMOXCLAV625', 1, 'BD')], drugs, allergies, activeItems: [] });
    expect(alerts).toEqual([expect.objectContaining({ type: 'ALLERGY', severity: 'HIGH' })]);
    expect(safetyAlerts({ lines: [lineFor('PARA500', 500, 'TDS')], drugs, allergies, activeItems: [] })).toEqual([]);
  });

  it('flags daily and single doses above the maximum', () => {
    expect(dailyDose(1000, 'QDS')).toBe(4000);
    expect(dailyDose(10, 'PRN')).toBeNull();
    expect(safetyAlerts({ lines: [lineFor('PARA500', 1000, 'QDS')], drugs, allergies: [], activeItems: [] })).toEqual([]);
    expect(safetyAlerts({ lines: [lineFor('PARA500', 1500, 'QDS')], drugs, allergies: [], activeItems: [] })[0].type).toBe('MAX_DOSE');
    expect(safetyAlerts({ lines: [lineFor('PARA500', 5000, 'PRN')], drugs, allergies: [], activeItems: [] })[0].type).toBe('MAX_DOSE');
  });

  it('separates duplicate therapy (blocking) from same-class use (warning), and notes controlled drugs', () => {
    const activeItems = [{ formularyItemId: 'id-IBU400', drugName: 'Ibuprofen', drugClasses: ['NSAID'] }];
    expect(safetyAlerts({ lines: [lineFor('IBU400', 400, 'TDS')], drugs, allergies: [], activeItems }).map((a) => a.type)).toEqual(['DUPLICATE_THERAPY']);
    expect(safetyAlerts({ lines: [lineFor('DICLO75_INJ', 75, 'STAT')], drugs, allergies: [], activeItems }).map((a) => [a.type, a.severity])).toEqual([['DUPLICATE_CLASS', 'MODERATE']]);
    expect(safetyAlerts({ lines: [lineFor('MORPH10_INJ', 5, 'STAT')], drugs, allergies: [], activeItems: [] }).map((a) => a.type)).toEqual(['CONTROLLED', 'HIGH_ALERT']);
  });

  it('requires a reason for every HIGH alert and records it', () => {
    const alerts = [{ drugCode: 'X', type: 'ALLERGY', severity: 'HIGH' }, { drugCode: 'X', type: 'DUPLICATE_CLASS', severity: 'MODERATE' }];
    expect(code(() => applyOverrides(alerts, []))).toBe('SAFETY_CHECK_REQUIRED');
    expect(code(() => applyOverrides(alerts, [{ drugCode: 'X', type: 'MAX_DOSE', reason: 'n/a' }]))).toBe('SAFETY_CHECK_REQUIRED');
    expect(applyOverrides(alerts, [{ drugCode: 'X', type: 'ALLERGY', reason: 'Tolerated before' }])[0].overrideReason).toBe('Tolerated before');
  });
});

describe('FEFO allocation', () => {
  const batches = [
    { id: 'a', batchNumber: 'A', expiryDate: '2026-01-10', quantityOnHand: 50 }, // expired relative to "today"
    { id: 'b', batchNumber: 'B', expiryDate: '2026-03-01', quantityOnHand: 5 },
    { id: 'c', batchNumber: 'C', expiryDate: '2027-01-01', quantityOnHand: 20 },
  ];
  it('takes the earliest in-date expiry first and never uses expired stock', () => {
    expect(allocateFefo(batches, 8, '2026-02-01', 'X').map((p) => [p.batch.id, p.quantity])).toEqual([['b', 5], ['c', 3]]);
  });
  it('treats a batch expiring today as expired and reports what is available', () => {
    expect(allocateFefo(batches, 20, '2026-03-01', 'X').map((p) => p.batch.id)).toEqual(['c']);
    expect(code(() => allocateFefo(batches, 26, '2026-02-01', 'X'))).toBe('INSUFFICIENT_STOCK');
  });
});

describe('statuses and current medicines', () => {
  it('derives item and prescription statuses from quantities', () => {
    expect(itemStatusFor({ status: 'ACTIVE', quantityDispensed: 10, quantityPrescribed: 10 })).toBe('COMPLETED');
    expect(itemStatusFor({ status: 'CANCELLED', quantityDispensed: 10, quantityPrescribed: 10 })).toBe('CANCELLED');
    const item = (dispensed, prescribed = 10, status = 'ACTIVE') => ({ quantityDispensed: dispensed, quantityPrescribed: prescribed, status });
    expect(prescriptionStatusFor([item(0), item(0)])).toBe('APPROVED');
    expect(prescriptionStatusFor([item(10), item(3)])).toBe('PARTIALLY_DISPENSED');
    expect(prescriptionStatusFor([item(10), item(0, 10, 'CANCELLED')])).toBe('DISPENSED');
  });

  it('keeps a course current until its duration ends', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const course = { createdAt: start, durationDays: 7, frequency: 'TDS', status: 'COMPLETED' };
    expect(courseEnd(course)).toBe(start.getTime() + 7 * 86_400_000);
    expect(isCurrent(course, start.getTime() + 6 * 86_400_000)).toBe(true);
    expect(isCurrent(course, start.getTime() + 8 * 86_400_000)).toBe(false);
    expect(isCurrent({ ...course, status: 'CANCELLED' }, start.getTime())).toBe(false);
    expect(isCurrent({ createdAt: start, frequency: 'STAT', status: 'ACTIVE' }, start.getTime() + 2 * 86_400_000)).toBe(false);
  });
});
