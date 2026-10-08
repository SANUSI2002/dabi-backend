// In-process notification worker (runs in the always-on API; NOTIFICATION_WORKER=false turns it off).
// Each tick: create upcoming doses → turn due reminders into notifications → send WhatsApp messages.
// All state is in the database, so a restart loses nothing, and every step is safe on several instances.
import { setInterval, clearInterval } from 'node:timers';
import { materializeDue, processDueReminders } from '../medication-schedules/schedule.service.js';
import { deliverDue } from './notification.delivery.js';

let timer = null;
let running = false;

export async function runNotificationWorkerOnce({ now = new Date() } = {}) {
  const materialized = await materializeDue({ now });
  const reminders = await processDueReminders({ now });
  const sent = await deliverDue({ now });
  return { materialized, reminders, sent };
}

export function startNotificationWorker({ intervalMs = 20_000 } = {}) {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runNotificationWorkerOnce();
    } catch (error) {
      console.error('[notifications] worker tick failed', error?.code ?? error?.name);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
}

export const stopNotificationWorker = () => { clearInterval(timer); timer = null; };
