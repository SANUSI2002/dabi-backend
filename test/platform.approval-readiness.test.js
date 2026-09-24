import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvalReadiness, requiredEvidence } from '../src/modules/platform/platform.approval-readiness.js';

const details = {
  organization: { country: 'Nigeria', state: 'Lagos', facilityType: 'Private Hospital', ownershipType: 'Private' },
  regulatoryRegistration: { registrationStatus: 'EXISTING' },
  selectedProducts: ['emr'],
};
const application = {
  status: 'UNDER_REVIEW', emailVerifiedAt: new Date('2026-09-24'), details,
  packageVersion: { status: 'PUBLISHED', moduleKeys: ['emr'] }, evidence: [],
};
afterEach(() => vi.unstubAllEnvs());

describe('EMR approval readiness', () => {
  it('requires the applicable server-side document set', () => {
    expect(requiredEvidence(details)).toEqual([
      'OFFICER_LICENCE', 'CAC_CERTIFICATE', 'TAX_EVIDENCE', 'FACILITY_REGISTRATION',
      'WASTE_MANAGEMENT', 'HMIS_RENDITION', 'SITE_DIAGRAM', 'PREVIOUS_CERTIFICATE',
    ]);
    expect(requiredEvidence({ ...details, organization: { ...details.organization, state: 'Kano' } })).toBeNull();
  });

  it('fails closed for missing uploads, scan results, and reviewer verification', () => {
    const result = approvalReadiness(application);
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('MISSING_DOCUMENT:OFFICER_LICENCE');
    expect(result.blockers).toContain('SECURE_DOCUMENT_WORKFLOW_NOT_CONNECTED');
    const unscanned = approvalReadiness({ ...application, evidence: [{ requirementKey: 'OFFICER_LICENCE', scanStatus: 'PENDING' }] });
    expect(unscanned.blockers).toContain('DOCUMENT_NOT_SCANNED:OFFICER_LICENCE');
  });

  it('does not treat selected products as proof of package entitlement or owner identity', () => {
    const result = approvalReadiness({ ...application, emailVerifiedAt: null, packageVersion: { status: 'DRAFT', moduleKeys: [] } });
    expect(result.blockers).toContain('OWNER_EMAIL_NOT_VERIFIED');
    expect(result.blockers).toContain('EMR_NOT_IN_PUBLISHED_PACKAGE');
  });

  it('keeps expired evidence and unsupported jurisdictions blocked', () => {
    const evidence = [{ requirementKey: 'OFFICER_LICENCE', storageBucket: 'sabi-hospital-evidence-clean', scanStatus: 'CLEAN', reviewStatus: 'VERIFIED', reviewedByUserId: 'reviewer', reviewedAt: new Date('2026-09-01'), expiresAt: new Date('2026-09-20') }];
    expect(approvalReadiness({ ...application, evidence }, new Date('2026-09-24')).blockers).toContain('DOCUMENT_EXPIRED:OFFICER_LICENCE');
    expect(approvalReadiness({ ...application, details: { ...details, organization: { ...details.organization, country: 'Ghana' } } }).blockers).toContain('MANUAL_REQUIREMENT_CONFIGURATION_REQUIRED');
  });

  it('cannot pass even if evidence metadata is injected before private upload and scanning are connected', () => {
    const evidence = requiredEvidence(details).map((requirementKey) => ({ requirementKey, storageBucket: 'sabi-hospital-evidence-clean', scanStatus: 'CLEAN', reviewStatus: 'VERIFIED', reviewedByUserId: 'reviewer', reviewedAt: new Date('2026-09-24'), expiresAt: null }));
    expect(approvalReadiness({ ...application, evidence }).blockers).toEqual(['SECURE_DOCUMENT_WORKFLOW_NOT_CONNECTED']);
    expect(approvalReadiness({ ...application, evidence: evidence.map((item) => ({ ...item, storageBucket: 'sabi-hospital-evidence-quarantine' })) }).blockers).toContain('DOCUMENT_NOT_SCANNED:OFFICER_LICENCE');
  });

  it('becomes ready only after all workflow gates and each verified clean document are present', () => {
    vi.stubEnv('HOSPITAL_EVIDENCE_INTAKE_ENABLED', 'true');
    vi.stubEnv('EVIDENCE_SCANNER_ENABLED', 'true');
    vi.stubEnv('HOSPITAL_EVIDENCE_REVIEW_ENABLED', 'true');
    const evidence = requiredEvidence(details).map((requirementKey) => ({
      id: requirementKey, requirementKey, createdAt: new Date('2026-09-24'), storageBucket: 'sabi-hospital-evidence-clean',
      scanStatus: 'CLEAN', reviewStatus: 'VERIFIED', reviewedByUserId: 'reviewer', reviewedAt: new Date('2026-09-24'), expiresAt: null,
    }));
    expect(approvalReadiness({ ...application, evidence }).ready).toBe(true);
    vi.stubEnv('HOSPITAL_EVIDENCE_REVIEW_ENABLED', 'false');
    expect(approvalReadiness({ ...application, evidence }).blockers).toContain('SECURE_DOCUMENT_WORKFLOW_NOT_CONNECTED');
  });
});
