import { afterEach, describe, expect, it, vi } from 'vitest';
import { doctorPortal } from '../src/modules/doctors/onboarding.service.js';

afterEach(() => vi.unstubAllEnvs());
describe('doctor verification email destination', () => {
  it('defaults to the standalone doctor domain', () => {
    vi.stubEnv('DOCTOR_PORTAL_URL', '');
    expect(doctorPortal()).toBe('https://doctor.sabihealth.org');
  });
  it('preserves an explicitly configured HTTPS portal and normalizes its trailing slash', () => {
    vi.stubEnv('DOCTOR_PORTAL_URL', 'https://doctor.example.test/');
    expect(doctorPortal()).toBe('https://doctor.example.test');
  });
  it.each(['http://doctor.example.test', 'https://user:password@doctor.example.test', 'https://doctor.example.test?token=x', 'https://doctor.example.test#token'])('rejects unsafe email destinations (%s)', (url) => {
    vi.stubEnv('DOCTOR_PORTAL_URL', url);
    expect(doctorPortal).toThrow('Doctor portal email URL is not configured.');
  });
});
