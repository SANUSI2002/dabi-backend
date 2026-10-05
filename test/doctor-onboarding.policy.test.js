import { describe, expect, it } from 'vitest';
import { approvalBlockers, eligibleDocument, latestCredentials } from '../src/modules/doctors/onboarding.policy.js';
import { registrationSchema } from '../src/modules/doctors/onboarding.validator.js';
const now = new Date('2026-10-05T12:00:00Z');
const doc = (kind, extra = {}) => ({ id: kind, kind, createdAt: now, scanStatus: 'CLEAN', storageBucket: 'sabi-hospital-evidence-clean', reviewStatus: 'VERIFIED', ...extra });
const profile = { user: { accountStatus: 'ACTIVE', emailVerifiedAt: now } };
const app = { submittedAt: now, details: { licenceType: 'annual', licenceExpiry: '2026-12-31' }, credentials: [doc('licence'), doc('registrationCertificate')] };
describe('doctor approval gates', () => {
  it('requires verified email, submitted evidence, current licence and independent verification of both clean files', () => {
    expect(approvalBlockers(profile, app, now)).toEqual([]);
    expect(approvalBlockers({ user: { accountStatus: 'PENDING' } }, app, now)).toContain('Email verification is incomplete.');
    expect(approvalBlockers(profile, { ...app, submittedAt: null }, now)).toContain('Credential submission is incomplete.');
    expect(approvalBlockers(profile, { ...app, details: { licenceType: 'annual', licenceExpiry: '2025-12-31' } }, now)).toContain('Practising licence has expired or its expiry is invalid.');
    expect(approvalBlockers(profile, null, now).length).toBeGreaterThan(3);
  });
  it.each(['PENDING', 'INFECTED', 'REJECTED', 'FAILED', 'UNSCANNED_EXCEPTION'])('never approves %s documents', (scanStatus) => {
    expect(eligibleDocument(doc('licence', { scanStatus, exceptionBy: 'admin', exceptionUntil: '2027-01-01' }))).toBe(false);
    expect(approvalBlockers(profile, { ...app, credentials: [doc('licence', { scanStatus }), doc('registrationCertificate')] }, now)).toContain('licence: clean malware screening required.');
  });
  it('does not treat malware clearance as authenticity or quarantine as clean delivery', () => {
    expect(eligibleDocument(doc('licence', { storageBucket: 'sabi-hospital-evidence-quarantine' }))).toBe(false);
    expect(approvalBlockers(profile, { ...app, credentials: [doc('licence', { reviewStatus: 'PENDING' }), doc('registrationCertificate')] }, now)).toContain('licence: authenticity verification required.');
  });
  it('replacement evidence supersedes previous verified evidence', () => {
    const replacement = doc('licence', { id: 'new', createdAt: new Date(now.getTime() + 1), scanStatus: 'PENDING', reviewStatus: 'PENDING' });
    expect(latestCredentials({ credentials: [...app.credentials, replacement] }).find((item) => item.kind === 'licence')).toBe(replacement);
    expect(approvalBlockers(profile, { ...app, credentials: [...app.credentials, replacement] }, now)).toContain('licence: authenticity verification required.');
  });
  it('validates explicit consent, rejects role injection, weak passwords and impossible expiry dates', () => {
    const body = { firstName: 'Ada', lastName: 'Test', email: 'ADA@example.test', phone: '+2348012345678', password: 'Long synthetic passphrase', specialty: 'General Practice', qualification: 'MBBS', university: 'Synthetic University', graduationYear: 2010, registrationNumber: 'TEST-001', practiceState: 'Lagos', city: 'Lagos', licenceType: 'annual', licenceExpiry: '2099-12-31', declaration: true, termsAccepted: true, country: 'NG', regulator: 'MDCN', consentVersion: 'doctor-registration-v1' };
    expect(registrationSchema.parse({ body }).body.email).toBe('ada@example.test');
    for (const extra of [{ role: 'SABI_PLATFORM_ADMIN' }, { password: 'short' }, { declaration: false }, { termsAccepted: false }, { licenceExpiry: '2099-02-30' }, { licenceExpiry: '2020-01-01' }]) expect(registrationSchema.safeParse({ body: { ...body, ...extra } }).success).toBe(false);
  });
});
