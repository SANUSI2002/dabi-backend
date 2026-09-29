// In-process EMR background worker (EMR_OUTBOX_WORKER=true). Each tick:
//   telehealth handoffs → outbox dispatch → webhook delivery; idempotency keys purged ~hourly.
// Every step is safe to run on several instances at once.
import { setInterval, clearInterval } from 'node:timers';
import { dispatchPending, deliverDue, purgeExpiredIdempotencyKeys } from './outbox.js';
import { processTelehealthHandoffs } from '../telehealth/telehealth.handoff.js';
import { logger } from './logging.js';

let timer = null;
let running = false;

export async function runEmrWorkerOnce({ purge = false } = {}) {
  await processTelehealthHandoffs();
  await dispatchPending();
  await deliverDue();
  if (purge) await purgeExpiredIdempotencyKeys();
}

export function startEmrWorker({ intervalMs = 5000 } = {}) {
  if (timer) return;
  let ticks = 0;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      ticks += 1;
      await runEmrWorkerOnce({ purge: ticks % 720 === 0 });
    } catch (error) {
      logger.error('emr.worker.tick_failed', { name: error?.name, code: error?.code });
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
}

export const stopEmrWorker = () => { clearInterval(timer); timer = null; };
