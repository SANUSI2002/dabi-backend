import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/config/db.js', () => ({ default: {} }));
const { createEvidencePoller } = await import('../src/modules/platform/platform.evidence-scanner.js');
afterEach(() => vi.unstubAllEnvs());
describe('independent background credential queues', () => {
  it('continues scanning doctor files even when the hospital queue fails repeatedly', async () => {
    vi.stubEnv('DOCTOR_REGISTRATION_ENABLED', 'true');
    const hospital = vi.fn(async () => { throw Object.assign(new Error('private database details'), { code: 'P2022' }); });
    const doctor = vi.fn(), report = vi.fn();
    const poll = createEvidencePoller({ hospital, doctor, report });
    for (let i = 0; i < 4; i++) await poll();
    expect(doctor).toHaveBeenCalledTimes(2); expect(hospital).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledWith('hospital', 'P2022'); expect(JSON.stringify(report.mock.calls)).not.toContain('private database details');
  });
  it('continues hospital scanning after a doctor queue failure', async () => {
    vi.stubEnv('DOCTOR_REGISTRATION_ENABLED', 'true');
    const hospital = vi.fn(), doctor = vi.fn(async () => { throw new Error('secret'); });
    const report = vi.fn(), poll = createEvidencePoller({ hospital, doctor, report });
    for (let i = 0; i < 4; i++) await poll();
    expect(hospital).toHaveBeenCalledTimes(2); expect(report).toHaveBeenCalledWith('doctor', 'QUEUE_UNAVAILABLE');
  });
  it('never starts overlapping scan jobs and keeps gated doctor queues disabled', async () => {
    vi.stubEnv('DOCTOR_REGISTRATION_ENABLED', 'false');
    let release; const hospital = vi.fn(() => new Promise((resolve) => { release = resolve; })), doctor = vi.fn();
    const poll = createEvidencePoller({ hospital, doctor });
    const first = poll(); await poll(); expect(hospital).toHaveBeenCalledTimes(1);
    release(); await first; expect(doctor).not.toHaveBeenCalled();
  });
});
