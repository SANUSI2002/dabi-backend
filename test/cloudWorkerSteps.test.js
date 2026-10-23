import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/db.js', () => ({ default: {} }));
import { runAutoDispatchOnce } from '../src/modules/riders/riders.operations.js';
import { runRiderTransferReconciliationOnce } from '../src/modules/riders/riders.payments.js';
import { reconcileSubscriptionOnce } from '../src/modules/command-centre/runtime.worker.js';

afterEach(() => vi.unstubAllEnvs());

describe('bounded worker steps for Google Cloud migration', () => {
  it('expires rider offers before considering dispatch, without inventing a published policy', async () => {
    const db = { deliveryAssignment: { findMany: vi.fn(async () => []) }, riderPayPolicy: { findUnique: vi.fn(async () => null) } };
    const dispatch = vi.fn();
    expect(await runAutoDispatchOnce({ db, dispatch })).toBe(0);
    expect(db.deliveryAssignment.findMany).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('bounds dispatch and preserves the transactional automatic-policy check', async () => {
    vi.stubEnv('RIDER_AUTO_DISPATCH_WORKER', 'true');
    const db = { deliveryAssignment: { findMany: vi.fn(async () => []) }, riderPayPolicy: { findUnique: vi.fn(async () => ({ published: true, automaticDispatch: true })) }, orderFulfilment: { findMany: vi.fn(async () => [{ id: 'fulfilment' }]) } };
    const dispatch = vi.fn();
    expect(await runAutoDispatchOnce({ db, dispatch })).toBe(1);
    expect(db.orderFulfilment.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10 }));
    expect(dispatch).toHaveBeenCalledWith('fulfilment', null, { db, requireAutomatic: true });
  });

  it('does not swallow infrastructure errors as successful dispatch', async () => {
    const db = { deliveryAssignment: { findMany: vi.fn(async () => { throw new Error('DB_UNAVAILABLE'); }) } };
    await expect(runAutoDispatchOnce({ db })).rejects.toThrow('DB_UNAVAILABLE');
  });

  it('does not touch transfers when provider operations are unconfigured', async () => {
    expect(await runRiderTransferReconciliationOnce({ db: {}, gateway: { operationsConfigured: () => false } })).toBe(0);
  });

  it('does not call the transfer provider after losing the compare-and-set claim', async () => {
    const db = { riderTransferAttempt: { findMany: vi.fn(async () => [{ id: 'transfer', reference: 'srp-synthetic', nextCheckAt: new Date(0) }]), updateMany: vi.fn(async () => ({ count: 0 })) } };
    const gateway = { operationsConfigured: () => true };
    expect(await runRiderTransferReconciliationOnce({ db, gateway })).toBe(1);
    expect(db.riderTransferAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { nextCheckAt: expect.any(Date) } }));
  });

  it('does not reconcile a subscription when another worker has claimed it', async () => {
    const db = { subscriptionPayment: { findFirst: vi.fn(async () => ({ id: 'payment', reference: 'synthetic', nextCheckAt: new Date(0) })), updateMany: vi.fn(async () => ({ count: 0 })) } };
    const reconcile = vi.fn();
    expect(await reconcileSubscriptionOnce({ db, reconcile, configured: () => true })).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('keeps a failed subscription pending with an operator-visible error code', async () => {
    const db = { subscriptionPayment: { findFirst: vi.fn(async () => ({ id: 'payment', reference: 'synthetic', nextCheckAt: new Date(0) })), updateMany: vi.fn(async () => ({ count: 1 })) } };
    const reconcile = vi.fn(async () => { throw Object.assign(new Error('not logged'), { code: 'PROVIDER_UNAVAILABLE' }); });
    expect(await reconcileSubscriptionOnce({ db, reconcile, configured: () => true })).toBe(true);
    expect(db.subscriptionPayment.updateMany).toHaveBeenLastCalledWith({ where: { id: 'payment', status: { not: 'PAID' } }, data: { errorCode: 'PROVIDER_UNAVAILABLE' } });
  });
});
