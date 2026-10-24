import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/config/db.js', () => ({ default: {} }));
import { jobRegistry } from '../src/runtime/job-registry.js';
import { JOB_KINDS } from '../src/runtime/job-kinds.js';
describe('serverless background coverage', () => {
  it('registers every former interval responsibility without importing an interval host', () => {
    expect(Object.keys(jobRegistry).sort()).toEqual([...JOB_KINDS].sort());
    expect(JOB_KINDS).toHaveLength(27);
    for (const job of Object.values(jobRegistry)) {
      expect(job.run).toBeTypeOf('function');
      expect(Number.isSafeInteger(job.intervalMs)).toBe(true);
      expect(job.intervalMs).toBeGreaterThanOrEqual(0);
    }
  });
});
