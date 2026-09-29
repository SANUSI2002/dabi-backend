// Laboratory rules — pure functions, no I/O.
import { EmrError } from '../core/errors.js';

/** Sex-specific range when the analyte has one, otherwise the general range. */
export function referenceRange(analyte, sex) {
  const specific = sex === 'FEMALE' ? analyte.female : sex === 'MALE' ? analyte.male : undefined;
  return { low: specific?.low ?? analyte.low, high: specific?.high ?? analyte.high };
}

/**
 * Interprets one entered value against its analyte definition. The flag is always computed here —
 * clients never send flags. Returns the row fields to store, or throws VALIDATION_FAILED.
 */
export function interpret(analyte, rawValue, sex) {
  const invalid = (message) => { throw new EmrError('VALIDATION_FAILED', { details: [{ field: analyte.code, message }] }); };
  if (analyte.kind === 'NUMERIC') {
    const value = typeof rawValue === 'number' ? rawValue : Number(String(rawValue).trim());
    if (rawValue === '' || rawValue === null || !Number.isFinite(value)) invalid('must be a number');
    if (Math.abs(value) >= 1e10) invalid('is out of range');
    const { low, high } = referenceRange(analyte, sex);
    let flag = null;
    if (analyte.criticalLow !== undefined && value < analyte.criticalLow) flag = 'CRITICAL_LOW';
    else if (analyte.criticalHigh !== undefined && value > analyte.criticalHigh) flag = 'CRITICAL_HIGH';
    else if (low !== undefined && value < low) flag = 'LOW';
    else if (high !== undefined && value > high) flag = 'HIGH';
    else if (low !== undefined || high !== undefined) flag = 'NORMAL';
    return { valueNumeric: value, valueText: null, unit: analyte.unit ?? null, referenceLow: low ?? null, referenceHigh: high ?? null, flag };
  }
  const text = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!text) invalid('is required');
  if (analyte.kind === 'CHOICE') {
    const option = analyte.options.find((o) => o.toUpperCase() === text.toUpperCase());
    if (!option) invalid(`must be one of ${analyte.options.join(', ')}`);
    const flag = analyte.normal ? (analyte.normal.includes(option) ? 'NORMAL' : 'ABNORMAL') : null;
    return { valueNumeric: null, valueText: option, unit: null, referenceLow: null, referenceHigh: null, flag };
  }
  if (text.length > 2000) invalid('is too long');
  return { valueNumeric: null, valueText: text, unit: null, referenceLow: null, referenceHigh: null, flag: null };
}

/** Every analyte of the test must be answered exactly once, and nothing else. */
export function interpretAll(analytes, entries, sex) {
  const byCode = new Map(entries.map((e) => [e.analyteCode, e.value]));
  const unknown = entries.filter((e) => !analytes.some((a) => a.code === e.analyteCode)).map((e) => e.analyteCode);
  const missing = analytes.filter((a) => !byCode.has(a.code)).map((a) => a.code);
  if (unknown.length || missing.length || byCode.size !== entries.length) {
    throw new EmrError('VALIDATION_FAILED', {
      message: 'Enter every analyte of the test exactly once.',
      details: [...missing.map((code) => ({ field: code, message: 'is missing' })), ...unknown.map((code) => ({ field: code, message: 'is not part of this test' }))],
    });
  }
  return analytes.map((analyte) => ({ analyteCode: analyte.code, analyteName: analyte.name, ...interpret(analyte, byCode.get(analyte.code), sex) }));
}

export const isCritical = (flag) => flag === 'CRITICAL_LOW' || flag === 'CRITICAL_HIGH';

// ---- order lifecycle: ORDERED → COLLECTED → IN_PROGRESS → COMPLETED; cancel before results ----
export function requireOrderStatus(order, allowed, action) {
  if (!allowed.includes(order.status)) {
    throw new EmrError('INVALID_STATE', { message: `A lab order that is ${order.status.toLowerCase().replace('_', ' ')} cannot be ${action}.` });
  }
}

export const accessionNumber = (year, value) => `LAB-${year}-${String(value).padStart(6, '0')}`;
