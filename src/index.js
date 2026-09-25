import 'dotenv/config';
import { app } from './app.js';
import { startExpiryRunner, stopExpiryRunner } from './modules/reservations/reservation.expiry.js';
import { privateStorageClient } from './config/privateStorage.js';
import { checkOrProvisionBuckets } from './config/supabaseBuckets.js';
import { startEvidenceScanner } from './modules/platform/platform.evidence-scanner.js';

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  console.log(`--Sabi Health backend securely running on port ${PORT}`);
});
// A read-only preflight verifies bucket privacy after deployment. It never
// creates buckets, logs credentials, or changes the application's DB target.
if (process.env.SUPABASE_URL || process.env.SUPABASE_SECRET_KEY) {
  Promise.resolve().then(() => checkOrProvisionBuckets(privateStorageClient())).then((buckets) => {
    const ready = buckets.filter((bucket) => bucket.state === 'READY').length;
    console.log(`[storage] ${ready}/${buckets.length} private buckets ready`);
  }).catch((error) => {
    console.error(`[storage] private bucket preflight failed: ${error.code ?? 'UNKNOWN_ERROR'}`);
  });
}
startExpiryRunner();
const stopEvidenceScanner = startEvidenceScanner();
const shutdown = () => { stopEvidenceScanner(); stopExpiryRunner(); server.close(() => process.exit(0)); };
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
