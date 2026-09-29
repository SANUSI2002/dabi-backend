// Pure billing rules (no database).
import { describe, expect, it } from 'vitest';
import { bedDays, invoiceStatusFor, invoiceTotals, lineAmounts, money, returnCreditDue, taxFor } from '../src/modules/emr/billing/billing.policy.js';

const code = (fn) => { try { fn(); return null; } catch (error) { return error.code; } };

describe('money arithmetic', () => {
  it('rounds tax half away from zero, like Postgres ROUND', () => {
    expect(taxFor(37_035n, 750)).toBe(2_778n); // 2,777.625
    expect(taxFor(-37_035n, 750)).toBe(-2_778n);
    expect(taxFor(10n, 500)).toBe(1n); // 0.5 → 1
    expect(taxFor(-10n, 500)).toBe(-1n);
    expect(taxFor(999n, 0)).toBe(0n);
  });

  it('stays exact beyond floating-point range', () => {
    const { amountMinor, taxMinor } = lineAmounts(3, 999_999_999_999n, 1_234);
    expect(amountMinor).toBe(2_999_999_999_997n);
    expect(taxMinor).toBe(370_200_000_000n); // 370,199,999,999.6298 → 370,200,000,000
  });

  it('only turns amounts into JSON numbers when that is lossless', () => {
    expect(money(123n)).toBe(123);
    expect(() => money(2n ** 60n)).toThrow(/safe integer/);
  });
});

describe('invoice totals and status', () => {
  const charges = [{ amountMinor: 500_000n, taxMinor: 0n }, { amountMinor: 37_035n, taxMinor: 2_778n }, { amountMinor: -10_000n, taxMinor: 0n }];
  it('adds charges and credits, then applies the discount', () => {
    expect(invoiceTotals(charges, 30_000n)).toEqual({ subtotalMinor: 527_035n, taxMinor: 2_778n, discountMinor: 30_000n, totalMinor: 499_813n });
  });
  it('refuses a discount above the amount owed, or credits above the charges', () => {
    expect(code(() => invoiceTotals(charges, 600_000n))).toBe('VALIDATION_FAILED');
    expect(code(() => invoiceTotals([{ amountMinor: -5n, taxMinor: 0n }]))).toBe('INVALID_STATE');
  });
  it('derives the payment status', () => {
    expect(invoiceStatusFor(100n, 0n)).toBe('ISSUED');
    expect(invoiceStatusFor(100n, 40n)).toBe('PARTIALLY_PAID');
    expect(invoiceStatusFor(100n, 100n)).toBe('PAID');
    expect(invoiceStatusFor(0n, 0n)).toBe('PAID'); // fully discounted
  });
});

describe('bed-days', () => {
  const t = (iso) => new Date(iso);
  const stay = (admittedAt, dischargedAt, status = dischargedAt ? 'DISCHARGED' : 'ADMITTED') => ({ admittedAt: t(admittedAt), dischargedAt: dischargedAt ? t(dischargedAt) : null, status });
  const assignment = (wardId, startedAt, endedAt = null) => ({ wardId, startedAt: t(startedAt), endedAt: endedAt ? t(endedAt) : null });

  it('charges one day per midnight, at the ward occupied that night', () => {
    const assignments = [assignment('general', '2026-10-01T10:00:00Z', '2026-10-02T15:00:00Z'), assignment('icu', '2026-10-02T15:00:00Z')];
    const days = bedDays({ admission: stay('2026-10-01T10:00:00Z', '2026-10-04T09:00:00Z'), assignments });
    expect(days).toEqual([{ date: '2026-10-01', wardId: 'general' }, { date: '2026-10-02', wardId: 'icu' }, { date: '2026-10-03', wardId: 'icu' }]);
  });

  it('charges a same-day discharge as one day-case day, but nothing while still in on day one', () => {
    const assignments = [assignment('general', '2026-10-01T08:00:00Z')];
    expect(bedDays({ admission: stay('2026-10-01T08:00:00Z', '2026-10-01T17:00:00Z'), assignments })).toEqual([{ date: '2026-10-01', wardId: 'general' }]);
    expect(bedDays({ admission: stay('2026-10-01T08:00:00Z', null), assignments, now: t('2026-10-01T20:00:00Z') })).toEqual([]);
  });

  it('counts nights so far for a current stay, and nothing for a cancelled one', () => {
    const assignments = [assignment('general', '2026-10-01T08:00:00Z')];
    expect(bedDays({ admission: stay('2026-10-01T08:00:00Z', null), assignments, now: t('2026-10-03T06:00:00Z') })).toHaveLength(2);
    expect(bedDays({ admission: { ...stay('2026-10-01T08:00:00Z', null), status: 'CANCELLED' }, assignments, now: t('2026-10-05T00:00:00Z') })).toEqual([]);
  });

  it('works out how much returned medicine is still to be credited', () => {
    expect(returnCreditDue(10, 0)).toBe(10);
    expect(returnCreditDue(15, 10)).toBe(5);
    expect(returnCreditDue(10, 10)).toBe(0);
  });
});
