// EMR errors: stable codes, fixed HTTP statuses, and a handler that never echoes internals.
// Another tenant's record is reported as NOT_FOUND (never FORBIDDEN) so IDs cannot be probed.
import { logger } from './logging.js';

const STATUS = {
  VALIDATION_FAILED: 400,
  AUTHENTICATION_REQUIRED: 401,
  ORGANIZATION_ACCESS_DENIED: 403,
  EMR_ACCESS_DENIED: 403,
  PERMISSION_DENIED: 403,
  PATIENT_NOT_FOUND: 404,
  ENCOUNTER_NOT_FOUND: 404,
  SUBSCRIPTION_NOT_FOUND: 404,
  NOT_FOUND: 404,
  MEDICAL_RECORD_NUMBER_IN_USE: 409,
  NATIONAL_ID_IN_USE: 409,
  PATIENT_ALREADY_LINKED: 409,
  PATIENT_INACTIVE: 409,
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
  ORGANIZATION_ACCESS_DENIED: 'Access denied.',
  EMR_ACCESS_DENIED: 'This organization has no active EMR entitlement.',
  PERMISSION_DENIED: 'Access denied.',
  PATIENT_NOT_FOUND: 'Patient not found.',
  ENCOUNTER_NOT_FOUND: 'Encounter not found.',
  SUBSCRIPTION_NOT_FOUND: 'Webhook subscription not found.',
  NOT_FOUND: 'Not found.',
  MEDICAL_RECORD_NUMBER_IN_USE: 'Medical record number is already in use for this organization.',
  NATIONAL_ID_IN_USE: 'Another patient in this organization already has this national ID.',
  PATIENT_ALREADY_LINKED: 'This Sabi account is already linked to another patient record.',
  PATIENT_INACTIVE: 'This patient record is inactive.',
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
