import 'dotenv/config';
import { checkAiProviders } from '../src/modules/ai/ai.readiness.js';
const allowed = new Set(['--execute-synthetic']);
if (process.argv.slice(2).some((arg) => !allowed.has(arg))) {
  console.error('Usage: npm run ai:check -- [--execute-synthetic]'); process.exitCode = 2;
} else {
  const result = await checkAiProviders({ execute: process.argv.includes('--execute-synthetic') });
  console.log(JSON.stringify(result, null, 2));
  if (process.argv.includes('--execute-synthetic') && Object.values(result.checks).some((c) => c.status !== 'VERIFIED')) process.exitCode = 1;
}
