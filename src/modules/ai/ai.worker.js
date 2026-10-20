import { setInterval, clearInterval } from 'node:timers';
import { processAiQueue, abortAiRuns } from './ai.service.js';
import { processAiSourceQueue, purgeRevokedAiSources } from './ai.sources.js';
export function startAiWorker() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await purgeRevokedAiSources(); await processAiQueue(); await processAiSourceQueue(); } catch { console.error('[ai] queue step unavailable'); } finally { busy = false; }
  };
  const timer = setInterval(tick, 1500); timer.unref(); return () => { clearInterval(timer); abortAiRuns(); };
}
