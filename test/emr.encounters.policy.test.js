// Pure clinical rules for encounters (no database). Database behaviour is in test/emr-db.
import { describe, expect, it } from 'vitest';
import { canSignKind, checkVitals, hasContent, requireEditableDraft, transitionData } from '../src/modules/emr/encounters/encounters.policy.js';

const code = (fn) => { try { fn(); return null; } catch (error) { return error.code; } };

describe('visit lifecycle', () => {
  it('allows ARRIVED → IN_PROGRESS → FINISHED and cancellation of open visits only', () => {
    const now = new Date('2026-09-29T10:00:00Z');
    expect(transitionData('start', { status: 'ARRIVED' }, {}, now)).toEqual({ status: 'IN_PROGRESS', startedAt: now });
    expect(transitionData('finish', { status: 'IN_PROGRESS' }, {}, now)).toEqual({ status: 'FINISHED', endedAt: now });
    expect(transitionData('cancel', { status: 'ARRIVED' }, { reason: 'Left' }, now)).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Left' });
    expect(code(() => transitionData('finish', { status: 'ARRIVED' }))).toBe('INVALID_STATE');
    expect(code(() => transitionData('start', { status: 'FINISHED' }))).toBe('INVALID_STATE');
    expect(code(() => transitionData('cancel', { status: 'FINISHED' }))).toBe('INVALID_STATE');
  });
});

describe('note signing', () => {
  it('doctors sign any note; nurses sign nursing notes only', () => {
    expect(canSignKind(['clinical.note.sign'], 'CONSULTATION')).toBe(true);
    expect(canSignKind(['nursing.note.sign'], 'NURSING')).toBe(true);
    expect(canSignKind(['nursing.note.sign'], 'CONSULTATION')).toBe(false);
    expect(canSignKind(['clinical.note.write'], 'NURSING')).toBe(false);
  });

  it('only the author edits a draft, and never a signed note', () => {
    expect(code(() => requireEditableDraft({ userId: 'a' }, { status: 'DRAFT', authorUserId: 'a' }))).toBeNull();
    expect(code(() => requireEditableDraft({ userId: 'b' }, { status: 'DRAFT', authorUserId: 'a' }))).toBe('PERMISSION_DENIED');
    expect(code(() => requireEditableDraft({ userId: 'a' }, { status: 'SIGNED', authorUserId: 'a' }))).toBe('NOTE_SIGNED');
  });

  it('treats whitespace-only notes as empty', () => {
    expect(hasContent({ body: '  ' })).toBe(false);
    expect(hasContent({ plan: 'Review in 2 weeks' })).toBe(true);
  });
});

describe('vital signs', () => {
  it('accepts plausible readings and rejects impossible ones', () => {
    expect(code(() => checkVitals([{ code: 'HEART_RATE', value: 72 }, { code: 'SPO2', value: 98 }]))).toBeNull();
    expect(code(() => checkVitals([{ code: 'SPO2', value: 101 }]))).toBe('VALIDATION_FAILED');
    expect(code(() => checkVitals([{ code: 'TEMPERATURE', value: 60 }]))).toBe('VALIDATION_FAILED');
    expect(code(() => checkVitals([{ code: 'HEART_RATE', value: 70 }, { code: 'HEART_RATE', value: 71 }]))).toBe('VALIDATION_FAILED');
  });

  it('needs both blood pressure values, systolic above diastolic', () => {
    expect(code(() => checkVitals([{ code: 'BP_SYSTOLIC', value: 120 }]))).toBe('VALIDATION_FAILED');
    expect(code(() => checkVitals([{ code: 'BP_SYSTOLIC', value: 80 }, { code: 'BP_DIASTOLIC', value: 90 }]))).toBe('VALIDATION_FAILED');
    expect(code(() => checkVitals([{ code: 'BP_SYSTOLIC', value: 120 }, { code: 'BP_DIASTOLIC', value: 80 }]))).toBeNull();
  });
});
