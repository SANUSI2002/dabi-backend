// EMR errors: stable codes, fixed HTTP statuses, and a handler that never echoes internals.
// Another tenant's record is reported as NOT_FOUND (never FORBIDDEN) so IDs cannot be probed.
import { logger } from './logging.js';

const STATUS = {
  VALIDATION_FAILED: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  WITNESS_REQUIRED: 400,
  AUTHENTICATION_REQUIRED: 401,
  ORGANIZATION_ACCESS_DENIED: 403,
  EMR_ACCESS_DENIED: 403,
  PERMISSION_DENIED: 403,
  PATIENT_NOT_FOUND: 404,
  ENCOUNTER_NOT_FOUND: 404,
  SUBSCRIPTION_NOT_FOUND: 404,
  NOTE_NOT_FOUND: 404,
  OBSERVATION_NOT_FOUND: 404,
  DIAGNOSIS_NOT_FOUND: 404,
  LAB_TEST_NOT_FOUND: 404,
  LAB_ORDER_NOT_FOUND: 404,
  LAB_ITEM_NOT_FOUND: 404,
  FORMULARY_ITEM_NOT_FOUND: 404,
  PRESCRIPTION_NOT_FOUND: 404,
  PRESCRIPTION_ITEM_NOT_FOUND: 404,
  BATCH_NOT_FOUND: 404,
  DISPENSE_NOT_FOUND: 404,
  ALLERGY_NOT_FOUND: 404,
  WARD_NOT_FOUND: 404,
  BED_NOT_FOUND: 404,
  ADMISSION_NOT_FOUND: 404,
  ADMINISTRATION_NOT_FOUND: 404,
  PRICE_ITEM_NOT_FOUND: 404,
  CHARGE_NOT_FOUND: 404,
  INVOICE_NOT_FOUND: 404,
  PAYMENT_NOT_FOUND: 404,
  NOT_FOUND: 404,
  MEDICAL_RECORD_NUMBER_IN_USE: 409,
  NATIONAL_ID_IN_USE: 409,
  HOSPITAL_NUMBER_IN_USE: 409,
  PATIENT_ALREADY_LINKED: 409,
  PATIENT_INACTIVE: 409,
  ENCOUNTER_ALREADY_OPEN: 409,
  NOTE_SIGNED: 409,
  PRIMARY_DIAGNOSIS_EXISTS: 409,
  LAB_TEST_CODE_IN_USE: 409,
  FORMULARY_CODE_IN_USE: 409,
  ALLERGY_ALREADY_RECORDED: 409,
  SAFETY_CHECK_REQUIRED: 409,
  INSUFFICIENT_STOCK: 409,
  WARD_CODE_IN_USE: 409,
  BED_CODE_IN_USE: 409,
  BED_NOT_AVAILABLE: 409,
  WARD_RESTRICTED: 409,
  PATIENT_ALREADY_ADMITTED: 409,
  ADMINISTRATION_NOT_ALLOWED: 409,
  PRICE_REFERENCE_IN_USE: 409,
  NOTHING_TO_INVOICE: 409,
  OVERPAYMENT: 409,
  NOTHING_WAITING: 404,
  QUEUE_ENTRY_NOT_FOUND: 404,
  INVALID_STATE: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  VERSION_CONFLICT: 412,
  IDEMPOTENCY_KEY_REUSED: 422,
  PRECONDITION_REQUIRED: 428,
  RATE_LIMITED: 429,
  EMR_DISABLED: 503,
  EMR_PATIENT_REGISTRY_DISABLED: 503,
};

const MESSAGES = {
  VALIDATION_FAILED: 'The request is not valid.',
  IDEMPOTENCY_KEY_REQUIRED: 'This action needs an Idempotency-Key header so a retry can never repeat it.',
  WITNESS_REQUIRED: 'Controlled medicines need a second pharmacy staff member as witness.',
  ORGANIZATION_ACCESS_DENIED: 'Access denied.',
  EMR_ACCESS_DENIED: 'This organization has no active EMR entitlement.',
  PERMISSION_DENIED: 'Access denied.',
  PATIENT_NOT_FOUND: 'Patient not found.',
  ENCOUNTER_NOT_FOUND: 'Encounter not found.',
  SUBSCRIPTION_NOT_FOUND: 'Webhook subscription not found.',
  NOTE_NOT_FOUND: 'Clinical note not found.',
  OBSERVATION_NOT_FOUND: 'Observation not found.',
  DIAGNOSIS_NOT_FOUND: 'Diagnosis not found.',
  LAB_TEST_NOT_FOUND: 'Lab test not found.',
  LAB_ORDER_NOT_FOUND: 'Lab order not found.',
  LAB_ITEM_NOT_FOUND: 'Ordered test not found.',
  FORMULARY_ITEM_NOT_FOUND: 'Formulary item not found.',
  PRESCRIPTION_NOT_FOUND: 'Prescription not found.',
  PRESCRIPTION_ITEM_NOT_FOUND: 'Prescription item not found.',
  BATCH_NOT_FOUND: 'Stock batch not found.',
  DISPENSE_NOT_FOUND: 'Dispense not found.',
  ALLERGY_NOT_FOUND: 'Allergy not found.',
  WARD_NOT_FOUND: 'Ward not found.',
  BED_NOT_FOUND: 'Bed not found.',
  ADMISSION_NOT_FOUND: 'Admission not found.',
  ADMINISTRATION_NOT_FOUND: 'Administration record not found.',
  PRICE_ITEM_NOT_FOUND: 'Price item not found.',
  CHARGE_NOT_FOUND: 'Charge not found.',
  INVOICE_NOT_FOUND: 'Invoice not found.',
  PAYMENT_NOT_FOUND: 'Payment not found.',
  NOT_FOUND: 'Not found.',
  MEDICAL_RECORD_NUMBER_IN_USE: 'Medical record number is already in use for this organization.',
  NATIONAL_ID_IN_USE: 'Another patient in this organization already has this national ID.',
  HOSPITAL_NUMBER_IN_USE: 'Another patient in this organization already has this hospital number.',
  NOTHING_WAITING: 'No patient is waiting at this station.',
  QUEUE_ENTRY_NOT_FOUND: 'Queue entry not found.',
  PATIENT_ALREADY_LINKED: 'This Sabi account is already linked to another patient record.',
  PATIENT_INACTIVE: 'This patient record is inactive.',
  ENCOUNTER_ALREADY_OPEN: 'This patient already has an open visit in this organization.',
  NOTE_SIGNED: 'This note is signed and can no longer be edited. Add an amendment instead.',
  PRIMARY_DIAGNOSIS_EXISTS: 'This visit already has an active primary diagnosis.',
  LAB_TEST_CODE_IN_USE: 'A lab test with this code already exists in this organization.',
  FORMULARY_CODE_IN_USE: 'A formulary item with this code already exists in this organization.',
  ALLERGY_ALREADY_RECORDED: 'This allergy is already recorded for the patient.',
  SAFETY_CHECK_REQUIRED: 'Safety checks need your attention.',
  INSUFFICIENT_STOCK: 'Not enough in-date stock.',
  WARD_CODE_IN_USE: 'A ward with this code already exists in this organization.',
  BED_CODE_IN_USE: 'A bed with this code already exists in this ward.',
  BED_NOT_AVAILABLE: 'This bed is not available.',
  WARD_RESTRICTED: 'This ward does not admit this patient.',
  PATIENT_ALREADY_ADMITTED: 'This patient is already admitted, or this visit already has an admission.',
  ADMINISTRATION_NOT_ALLOWED: 'This dose cannot be charted now.',
  PRICE_REFERENCE_IN_USE: 'A price for this item already exists.',
  NOTHING_TO_INVOICE: 'There are no unbilled charges for this visit.',
  OVERPAYMENT: 'The payment is more than the balance due.',
  INVALID_STATE: 'This action is not allowed in the record\'s current state.',
  IDEMPOTENCY_IN_PROGRESS: 'A request with this idempotency key is still being processed.',
  VERSION_CONFLICT: 'This record was changed by someone else. Reload it and try again.',
  IDEMPOTENCY_KEY_REUSED: 'This idempotency key was already used with a different request.',
  PRECONDITION_REQUIRED: 'Send the record version in the If-Match header.',
  RATE_LIMITED: 'Too many requests for this organization. Please retry later.',
  EMR_DISABLED: 'The EMR service is not enabled.',
  EMR_PATIENT_REGISTRY_DISABLED: 'The clinical test registry is not enabled.',
};

export class EmrError extends Error {
  constructor(code, { message, details, headers } = {}) {
    super(code);
    this.code = code;
    this.status = STATUS[code] ?? 500;
    this.publicMessage = message ?? MESSAGES[code] ?? 'The request could not be completed.';
    this.details = details;
    this.headers = headers;
  }
}

export const fail = (code, options) => { throw new EmrError(code, options); };

// Prisma unique-constraint violations → domain codes (never the raw constraint text).
export const uniqueViolation = (error, map) => {
  if (error?.code !== 'P2002') return null;
  // Prisma reports the violated key in different places depending on the index kind: `target`
  // (classic), constraint fields (driver adapter), or — for partial unique indexes — only the
  // constraint name inside the driver message. Collect all of them.
  const cause = error.meta?.driverAdapterError?.cause;
  const target = [
    ...[].concat(error.meta?.target ?? []),
    ...[].concat(cause?.constraint?.fields ?? []),
    cause?.constraint?.index ?? '',
    /unique constraint "([^"]+)"/.exec(cause?.originalMessage ?? '')?.[1] ?? '',
  ].join(',');
  for (const [needle, code] of Object.entries(map)) if (target.includes(needle)) return new EmrError(code);
  return new EmrError(Object.values(map)[0]);
};

export const sendError = (res, error, requestId) => {
  if (error.headers) res.set(error.headers);
  res.status(error.status).set('Cache-Control', 'no-store').json({
    status: 'error',
    error: { code: error.code, message: error.publicMessage, ...(error.details ? { details: error.details } : {}), requestId },
  });
};

// Last handler on every EMR router.
export const emrErrorHandler = (error, req, res, next) => {
  if (error instanceof EmrError) return sendError(res, error, req.requestId);
  logger.error('emr.unhandled_error', {
    requestId: req.requestId, organizationId: req.emr?.organizationId, route: req.route?.path, code: error?.code, name: error?.name,
    // Raw messages can echo patient data, so they are only logged when explicitly debugging locally.
    ...(process.env.NODE_ENV !== 'production' && process.env.EMR_DEBUG_ERRORS === 'true' ? { message: String(error?.message).slice(0, 2000) } : {}),
  });
  return sendError(res, new EmrError('INTERNAL', { message: 'The EMR service could not complete this request.' }), req.requestId);
};
