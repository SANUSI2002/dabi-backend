import { processAiQueue } from '../modules/ai/ai.service.js';
import { processAiSourceQueue, purgeRevokedAiSources } from '../modules/ai/ai.sources.js';
import { processKnowledgeQueue } from '../modules/ai/ai.knowledge.js';
import { processJevAssessmentQueue } from '../modules/ai/jev/jev.assessments.js';
import { processEvidenceJob } from '../modules/platform/platform.evidence-scanner.js';
import { evidenceScannerConfigured } from '../config/evidenceScanner.js';
import { processDoctorCredentialJob } from '../modules/doctors/onboarding.scanner.js';
import { processPharmacyCredentialJob } from '../modules/pharmacies/portal.scanner.js';
import { deliverPharmacyEmail, queueLicenceReminders } from '../modules/pharmacies/portal.email.js';
import { processRiderCredentialJob, processRiderEmailJob } from '../modules/riders/riders.worker.js';
import { processPatientDocument, cleanDeletedPatientDocuments } from '../modules/medical-documents/medical-documents.worker.js';
import { intakeConfigured } from '../modules/medical-documents/medical-documents.intake.js';
import { scanFinanceAttachments, cleanFinanceAttachments } from '../modules/accounting/attachments/attachments.worker.js';
import { configured as financeConfigured } from '../modules/accounting/attachments/attachments.service.js';
import { deliverCustomerEmails } from '../modules/accounting/email/customerEmail.js';
import { sendSubscriptionMail, reconcileSubscriptionOnce, pruneTracking } from '../modules/command-centre/runtime.worker.js';
import { runAutoDispatchOnce } from '../modules/riders/riders.operations.js';
import { runRiderTransferReconciliationOnce } from '../modules/riders/riders.payments.js';
import { runExpiry } from '../modules/reservations/reservation.expiry.js';
import { runNotificationWorkerOnce } from '../modules/notifications/notification.worker.js';
import { runEmrWorkerOnce } from '../modules/emr/core/worker.js';
import { purgeExpiredIdempotencyKeys } from '../modules/emr/core/outbox.js';
import { videoService } from '../modules/doctor-video/doctor-video.service.js';

const minute = 60_000;
const hour = 60 * minute;
const step = (run, { intervalMs = minute, enabled = () => true, drain = false } = {}) => ({
  intervalMs,
  run: async () => {
    if (!enabled()) return {};
    const processed = await run();
    return drain && processed ? { continue: true, nextDelayMs: 0 } : {};
  },
});
export const jobRegistry = Object.freeze({
  'ai-chat': step(processAiQueue, { intervalMs: 0, drain: true }),
  'ai-sources': step(processAiSourceQueue, { drain: true }),
  'ai-knowledge': step(processKnowledgeQueue, { drain: true }),
  'ai-purge': step(purgeRevokedAiSources),
  'jev': step(processJevAssessmentQueue, { drain: true }),
  'hospital-screening': step(processEvidenceJob, { enabled: evidenceScannerConfigured, drain: true }),
  'doctor-screening': step(processDoctorCredentialJob, { enabled: evidenceScannerConfigured, drain: true }),
  'pharmacy-screening': step(processPharmacyCredentialJob, { enabled: evidenceScannerConfigured, drain: true }),
  'rider-screening': step(processRiderCredentialJob, { enabled: evidenceScannerConfigured, drain: true }),
  'patient-screening': step(processPatientDocument, { enabled: intakeConfigured, drain: true }),
  'patient-cleanup': step(cleanDeletedPatientDocuments, { enabled: intakeConfigured }),
  'finance-screening': step(() => scanFinanceAttachments({ limit: 1 }), { enabled: financeConfigured, drain: true }),
  'finance-cleanup': step(cleanFinanceAttachments, { enabled: financeConfigured }),
  'pharmacy-mail': step(async () => (await deliverPharmacyEmail()).claimed, { drain: true }),
  'pharmacy-licence-reminders': {
    intervalMs: hour,
    run: async cursor => {
      const result = await queueLicenceReminders({ afterId: cursor });
      return { cursor: result.nextCursor, nextDelayMs: result.nextCursor ? minute : hour };
    },
  },
  'rider-mail': step(processRiderEmailJob, { drain: true }),
  'finance-mail': step(deliverCustomerEmails),
  'subscription-mail': step(sendSubscriptionMail, { drain: true }),
  'subscription-reconciliation': step(reconcileSubscriptionOnce),
  'rider-reconciliation': step(runRiderTransferReconciliationOnce),
  'rider-dispatch': step(runAutoDispatchOnce),
  'reservation-expiry': step(() => runExpiry({ strict: true })),
  'notifications': step(() => runNotificationWorkerOnce({ deliveryLimit: 10 }), { enabled: () => process.env.NOTIFICATION_WORKER !== 'false' }),
  'emr-outbox': step(() => runEmrWorkerOnce({ deliveryLimit: 10 }), { enabled: () => process.env.EMR_OUTBOX_WORKER === 'true' }),
  'emr-idempotency-cleanup': step(purgeExpiredIdempotencyKeys, { intervalMs: hour, enabled: () => process.env.EMR_OUTBOX_WORKER === 'true' }),
  'video-cleanup': step(() => videoService.cleanup()),
  'tracking-cleanup': step(() => pruneTracking(), { intervalMs: hour }),
});
