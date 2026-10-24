import { describe, expect, it } from 'vitest';
import { assertTestResults } from '../scripts/verify-test-results.mjs';

const passing = { success: true, numFailedTests: 0, numFailedTestSuites: 0, numTotalTests: 10 };
describe('independent CI test-results gate', () => {
  it('accepts a complete successful report', () => expect(assertTestResults(passing)).toBe(10));
  it.each([undefined, {}, { ...passing, success: false }, { ...passing, numFailedTests: 1 }, { ...passing, numFailedTestSuites: 1 }, { ...passing, numTotalTests: 0 }])('rejects missing or failing results even after a zero runner exit', report => {
    expect(() => assertTestResults(report)).toThrow();
  });
});
