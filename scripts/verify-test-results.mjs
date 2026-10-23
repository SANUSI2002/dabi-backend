import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// A test runner or teardown can report a zero exit status despite a failure.
// Require its machine-readable results as a second, independent release gate.
export function assertTestResults(report) {
  if (report?.success !== true || report.numFailedTests !== 0
    || report.numFailedTestSuites !== 0 || !(report.numTotalTests > 0)) {
    throw new Error('Test results are missing, incomplete or contain failures.');
  }
  return report.numTotalTests;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const count = assertTestResults(JSON.parse(await readFile(process.argv[2], 'utf8')));
  console.log(`Verified machine-readable results for ${count} tests.`);
}
