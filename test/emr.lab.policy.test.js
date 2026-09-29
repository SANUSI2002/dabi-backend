// Pure laboratory rules (no database): flags, sex-specific ranges, choice answers, completeness,
// and catalog validation.
import { describe, expect, it } from 'vitest';
import { accessionNumber, interpret, interpretAll } from '../src/modules/emr/lab/lab.policy.js';
import { DEFAULT_TESTS, analytesSchema } from '../src/modules/emr/lab/lab.catalog.js';

const fbc = DEFAULT_TESTS.find((t) => t.code === 'FBC').analytes;
const hb = fbc.find((a) => a.code === 'HB');
const code = (fn) => { try { fn(); return null; } catch (error) { return error.code; } };

describe('numeric flags', () => {
  it('uses critical limits before reference limits', () => {
    expect(interpret(hb, 6.9, 'FEMALE').flag).toBe('CRITICAL_LOW');
    expect(interpret(hb, 11, 'FEMALE').flag).toBe('LOW');
    expect(interpret(hb, 14, 'FEMALE').flag).toBe('NORMAL');
    expect(interpret(hb, 16, 'FEMALE').flag).toBe('HIGH');
    expect(interpret(hb, 21, 'MALE').flag).toBe('CRITICAL_HIGH');
  });

  it('applies sex-specific reference ranges, falling back to the general range', () => {
    expect(interpret(hb, 13, 'FEMALE')).toMatchObject({ flag: 'NORMAL', referenceLow: 12, referenceHigh: 15.5 });
    expect(interpret(hb, 13, 'MALE')).toMatchObject({ flag: 'LOW', referenceLow: 13.5, referenceHigh: 17.5 });
    expect(interpret(hb, 13, 'UNKNOWN')).toMatchObject({ flag: 'NORMAL', referenceLow: 12, referenceHigh: 17 });
  });

  it('handles one-sided ranges and accepts numeric strings', () => {
    const hdl = DEFAULT_TESTS.find((t) => t.code === 'LIPID').analytes.find((a) => a.code === 'HDL');
    expect(interpret(hdl, '0.8').flag).toBe('LOW');
    expect(interpret(hdl, 2.5).flag).toBe('NORMAL');
    expect(code(() => interpret(hdl, 'abc'))).toBe('VALIDATION_FAILED');
    expect(code(() => interpret(hdl, ''))).toBe('VALIDATION_FAILED');
  });
});

describe('choice and text answers', () => {
  const mp = DEFAULT_TESTS.find((t) => t.code === 'MP_RDT').analytes[0];
  const hcg = DEFAULT_TESTS.find((t) => t.code === 'PREG').analytes[0];

  it('normalises case, flags non-normal answers, and rejects unknown ones', () => {
    expect(interpret(mp, 'negative')).toMatchObject({ valueText: 'NEGATIVE', flag: 'NORMAL' });
    expect(interpret(mp, 'POSITIVE').flag).toBe('ABNORMAL');
    expect(code(() => interpret(mp, 'unclear'))).toBe('VALIDATION_FAILED');
  });

  it('raises no flag when a test has no "normal" answer', () => {
    expect(interpret(hcg, 'POSITIVE').flag).toBeNull();
  });
});

describe('completeness', () => {
  it('requires every analyte exactly once and nothing extra', () => {
    const all = fbc.map((a) => ({ analyteCode: a.code, value: 10 }));
    expect(interpretAll(fbc, all, 'FEMALE')).toHaveLength(fbc.length);
    expect(code(() => interpretAll(fbc, all.slice(1), 'FEMALE'))).toBe('VALIDATION_FAILED');
    expect(code(() => interpretAll(fbc, [...all, { analyteCode: 'XYZ', value: 1 }], 'FEMALE'))).toBe('VALIDATION_FAILED');
    expect(code(() => interpretAll(fbc, [...all, all[0]], 'FEMALE'))).toBe('VALIDATION_FAILED');
  });
});

describe('catalog validation', () => {
  it('accepts the starter catalog and rejects inconsistent definitions', () => {
    for (const test of DEFAULT_TESTS) expect(analytesSchema.safeParse(test.analytes).success).toBe(true);
    const bad = (analyte) => analytesSchema.safeParse([analyte]).success;
    expect(bad({ code: 'X', name: 'X', kind: 'NUMERIC', low: 5, high: 1 })).toBe(false);
    expect(bad({ code: 'X', name: 'X', kind: 'NUMERIC', low: 5, criticalLow: 6 })).toBe(false);
    expect(bad({ code: 'X', name: 'X', kind: 'CHOICE' })).toBe(false);
    expect(bad({ code: 'X', name: 'X', kind: 'CHOICE', options: ['A', 'B'], normal: ['C'] })).toBe(false);
    expect(bad({ code: 'X', name: 'X', kind: 'TEXT', unit: 'mg' })).toBe(false);
    expect(analytesSchema.safeParse([{ code: 'A', name: 'A', kind: 'TEXT' }, { code: 'A', name: 'B', kind: 'TEXT' }]).success).toBe(false);
  });

  it('formats accession numbers', () => {
    expect(accessionNumber(2026, 42)).toBe('LAB-2026-000042');
  });
});
