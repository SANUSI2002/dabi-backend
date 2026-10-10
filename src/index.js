import 'dotenv/config';
import { app } from './app.js';
import { startExpiryRunner, stopExpiryRunner } from './modules/reservations/reservation.expiry.js';
import { privateStorageClient } from './config/privateStorage.js';
import { checkOrProvisionBuckets } from './config/supabaseBuckets.js';
import { startEvidenceScanner } from './modules/platform/platform.evidence-scanner.js';
import { startPharmacyScanner } from './modules/pharmacies/portal.scanner.js';
import { startPharmacyMailWorker } from './modules/pharmacies/portal.email.js';
import { startVideoCleanup } from './modules/doctor-video/doctor-video.service.js';
import { startEmrWorker, stopEmrWorker } from './modules/emr/core/worker.js';
import { startNotificationWorker, stopNotificationWorker } from './modules/notifications/notification.worker.js';

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
const stopPharmacyScanner = startPharmacyScanner();
const stopPharmacyMail = startPharmacyMailWorker();
const stopVideoCleanup = startVideoCleanup();
// EMR worker (telehealth handoff, outbox → webhooks). Off by default; safe on several instances.
if (process.env.EMR_OUTBOX_WORKER === 'true') startEmrWorker();
// Medication reminders and WhatsApp deliveries. On by default; safe on several instances.
if (process.env.NOTIFICATION_WORKER !== 'false') startNotificationWorker();
const shutdown = () => { stopNotificationWorker(); stopVideoCleanup(); stopEmrWorker(); stopPharmacyMail(); stopPharmacyScanner(); stopEvidenceScanner(); stopExpiryRunner(); server.close(() => process.exit(0)); };
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
