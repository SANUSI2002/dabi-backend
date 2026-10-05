const MAX_BYTES = 10 * 1024 * 1024;
export const evidenceScannerProvider = () => process.env.EVIDENCE_SCANNER_PROVIDER || 'clamav';
export function evidenceUploadMaxBytes() {
  if (evidenceScannerProvider() !== 'cloudmersive') return MAX_BYTES;
  // Conservative decimal limit compatible with the evaluation plan. A higher
  // limit requires the operator to have a plan supporting it; never auto-upgrade.
  const configured = Number(process.env.CLOUDMERSIVE_MAX_FILE_BYTES || 3500000);
  return Number.isSafeInteger(configured) && configured > 0 && configured <= MAX_BYTES ? configured : 3500000;
}
export function cloudmersiveConfigured() {
  return Boolean(process.env.CLOUDMERSIVE_API_KEY?.trim())
    && process.env.CLOUDMERSIVE_CREDENTIAL_PROCESSING_APPROVED === 'true';
}
export function evidenceScannerConfigured() {
  return process.env.EVIDENCE_SCANNER_ENABLED === 'true'
    && (evidenceScannerProvider() === 'clamav' || evidenceScannerProvider() === 'cloudmersive' && cloudmersiveConfigured());
}
