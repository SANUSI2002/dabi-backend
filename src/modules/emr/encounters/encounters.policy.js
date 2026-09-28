// Clinical rules for encounters, notes, vitals and diagnoses — pure functions, no I/O.
import { EmrError } from '../core/errors.js';

// ---- visit lifecycle: ARRIVED → IN_PROGRESS → FINISHED; ARRIVED/IN_PROGRESS → CANCELLED ----
export const OPEN_STATUSES = ['ARRIVED', 'IN_PROGRESS'];
const TRANSITIONS = {
  start: { from: ['ARRIVED'], to: 'IN_PROGRESS' },
  finish: { from: ['IN_PROGRESS'], to: 'FINISHED' },
  cancel: { from: ['ARRIVED', 'IN_PROGRESS'], to: 'CANCELLED' },
};

export function transitionData(action, encounter, { reason } = {}, now = new Date()) {
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(encounter.status)) {
    throw new EmrError('INVALID_STATE', { message: `A visit that is ${encounter.status.toLowerCase().replace('_', ' ')} cannot be ${action === 'cancel' ? 'cancelled' : `${action}ed`}.` });
  }
  if (action === 'start') return { status: rule.to, startedAt: now };
  if (action === 'finish') return { status: rule.to, endedAt: now };
  return { status: rule.to, endedAt: now, cancellationReason: reason };
}

export const requireOpen = (encounter) => {
  if (!OPEN_STATUSES.includes(encounter.status)) throw new EmrError('INVALID_STATE', { message: 'This visit is closed.' });
};
export const requireNotCancelled = (encounter) => {
  if (encounter.status === 'CANCELLED') throw new EmrError('INVALID_STATE', { message: 'This visit was cancelled.' });
};

// ---- notes: you may only write a kind of note you are allowed to sign (no orphan drafts) ----
export const canSignKind = (permissions, kind) =>
  permissions.includes('clinical.note.sign') || (kind === 'NURSING' && permissions.includes('nursing.note.sign'));

export function requireSignableKind(context, kind) {
  if (!canSignKind(context.permissions, kind)) {
    throw new EmrError('PERMISSION_DENIED', { message: `You are not allowed to write or sign ${kind.toLowerCase()} notes.` });
  }
}

export function requireEditableDraft(context, note) {
  if (note.status === 'SIGNED') throw new EmrError('NOTE_SIGNED');
  if (note.authorUserId !== context.userId) throw new EmrError('PERMISSION_DENIED', { message: 'Only the author can edit or sign a draft note.' });
}

export const NOTE_FIELDS = ['subjective', 'objective', 'assessment', 'plan', 'body'];
export const hasContent = (note) => NOTE_FIELDS.some((field) => typeof note[field] === 'string' && note[field].trim().length > 0);

// ---- vital signs: fixed units and plausibility ranges ----
export const VITALS = {
  BP_SYSTOLIC: { unit: 'mmHg', min: 40, max: 300 },
  BP_DIASTOLIC: { unit: 'mmHg', min: 20, max: 200 },
  HEART_RATE: { unit: '/min', min: 20, max: 300 },
  RESPIRATORY_RATE: { unit: '/min', min: 4, max: 80 },
  TEMPERATURE: { unit: 'Cel', min: 30, max: 45 },
  SPO2: { unit: '%', min: 50, max: 100 },
  WEIGHT: { unit: 'kg', min: 0.3, max: 400 },
  HEIGHT: { unit: 'cm', min: 20, max: 260 },
  BLOOD_GLUCOSE: { unit: 'mmol/L', min: 0.5, max: 50 },
  PAIN_SCORE: { unit: '{score}', min: 0, max: 10 },
};

export function checkVitals(readings) {
  const problems = [];
  const seen = new Set();
  readings.forEach(({ code, value }, index) => {
    const spec = VITALS[code];
    if (seen.has(code)) problems.push({ field: `readings.${index}.code`, message: `${code} is listed twice` });
    seen.add(code);
    if (value < spec.min || value > spec.max) problems.push({ field: `readings.${index}.value`, message: `${code} must be between ${spec.min} and ${spec.max} ${spec.unit}` });
  });
  const systolic = readings.find((r) => r.code === 'BP_SYSTOLIC');
  const diastolic = readings.find((r) => r.code === 'BP_DIASTOLIC');
  if (!!systolic !== !!diastolic) problems.push({ field: 'readings', message: 'Blood pressure needs both systolic and diastolic values' });
  if (systolic && diastolic && systolic.value <= diastolic.value) problems.push({ field: 'readings', message: 'Systolic pressure must be higher than diastolic' });
  if (problems.length) throw new EmrError('VALIDATION_FAILED', { details: problems });
}
