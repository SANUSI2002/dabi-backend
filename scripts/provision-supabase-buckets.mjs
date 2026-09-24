import 'dotenv/config';
import { privateStorageClient } from '../src/config/privateStorage.js';
import { checkOrProvisionBuckets } from '../src/config/supabaseBuckets.js';

const apply = process.argv.length === 3 && process.argv[2] === '--apply';
if (process.argv.length > 2 && !apply) {
  console.error('Usage: node scripts/provision-supabase-buckets.mjs [--apply]');
  process.exitCode = 2;
} else {
  try {
    const expectedRef = process.env.SUPABASE_EXPECTED_PROJECT_REF;
    const url = process.env.SUPABASE_URL;
    if (!/^[a-z0-9]{20}$/.test(expectedRef ?? '') || !url || new URL(url).hostname !== `${expectedRef}.supabase.co`) {
      throw new Error('SUPABASE_PROJECT_REF_MISMATCH');
    }
    const results = await checkOrProvisionBuckets(privateStorageClient(), { apply });
    for (const result of results) console.log(`${result.id}: ${result.state}`);
    if (results.some((result) => result.state !== 'READY')) process.exitCode = 1;
  } catch (error) {
    // Never print provider response bodies, URLs, or credentials.
    console.error(`Supabase private bucket setup failed: ${error.code ?? error.message ?? 'UNKNOWN_ERROR'}`);
    process.exitCode = 1;
  }
}
