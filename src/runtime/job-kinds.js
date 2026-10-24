// Only static job categories enter Cloud Tasks, never document/user IDs or text.
export const JOB_KINDS = Object.freeze([
  'ai-chat', 'ai-sources', 'ai-knowledge', 'ai-purge', 'jev',
  'hospital-screening', 'doctor-screening', 'pharmacy-screening', 'rider-screening',
  'patient-screening', 'patient-cleanup', 'finance-screening', 'finance-cleanup',
  'pharmacy-mail', 'pharmacy-licence-reminders', 'rider-mail', 'finance-mail',
  'subscription-mail', 'subscription-reconciliation', 'rider-reconciliation',
  'rider-dispatch', 'reservation-expiry', 'notifications', 'emr-outbox',
  'emr-idempotency-cleanup', 'video-cleanup', 'tracking-cleanup',
]);
export const validJobKind = kind => JOB_KINDS.includes(kind);
