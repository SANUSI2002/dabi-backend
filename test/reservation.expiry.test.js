import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const due = vi.fn();
const release = vi.fn();
vi.mock('../src/modules/reservations/reservation.repository.js', () => ({ due }));
vi.mock('../src/modules/reservations/reservation.service.js', () => ({ release }));
const { runExpiry, startExpiryRunner, stopExpiryRunner } = await import('../src/modules/reservations/reservation.expiry.js');

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); delete process.env.SKIP_DB_CONNECT; due.mockResolvedValue([{ id: 'a', patientId: 'p' }]); release.mockResolvedValue(true); });
afterEach(() => { stopExpiryRunner(); vi.useRealTimers(); delete process.env.SKIP_DB_CONNECT; });

describe('reservation expiry runner', () => {
  it('runs startup cleanup for due reservations', async () => { await expect(runExpiry()).resolves.toBe(1); expect(release).toHaveBeenCalledWith('p', 'a'); });
  it('runs bounded periodic cleanup and unrefs its timer', async () => { const unref = vi.fn(); const interval = vi.spyOn(globalThis, 'setInterval').mockReturnValue({ unref }); startExpiryRunner({ intervalMs: 10 }); await vi.advanceTimersByTimeAsync(10); expect(interval).toHaveBeenCalled(); expect(unref).toHaveBeenCalled(); expect(release).toHaveBeenCalled(); });
  it('does no database work when database connection is skipped', async () => { process.env.SKIP_DB_CONNECT = 'true'; await expect(runExpiry()).resolves.toBe(0); startExpiryRunner(); expect(due).not.toHaveBeenCalled(); });
  it('contains cleanup failures', async () => { due.mockRejectedValue(new Error('db secret')); await expect(runExpiry()).resolves.toBe(0); });
  it('clears the timer on shutdown', () => { const clear = vi.spyOn(globalThis, 'clearInterval'); startExpiryRunner(); stopExpiryRunner(); expect(clear).toHaveBeenCalled(); });
});
