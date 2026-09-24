// Deliberately separate from scanner CLEAN. This short-lived exception is only
// for the disposable test service while no always-on scanner host exists.
export function unscannedExceptionEnabled(now = new Date()) {
  if (process.env.HOSPITAL_UNSCANNED_EXCEPTION_ENABLED !== 'true') return false;
  const raw = process.env.HOSPITAL_UNSCANNED_EXCEPTION_UNTIL;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(raw ?? '')) return false;
  const expiry = new Date(raw);
  return Number.isFinite(expiry.getTime()) && expiry > now && expiry <= new Date(now.getTime() + 30 * 24 * 60 * 60_000);
}

export const evidenceWorkflowAvailable = () =>
  process.env.EVIDENCE_SCANNER_ENABLED === 'true' || unscannedExceptionEnabled();
