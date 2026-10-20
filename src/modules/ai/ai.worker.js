import { setInterval, clearInterval } from 'node:timers';
import { processAiQueue, abortAiRuns } from './ai.service.js';
import { processAiSourceQueue, purgeRevokedAiSources } from './ai.sources.js';
import { processJevAssessmentQueue } from './jev/jev.assessments.js';
export function startAiWorker() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      // A failing source purge must not starve unrelated conversations or assessments.
      for (const step of [purgeRevokedAiSources, processAiQueue, processAiSourceQueue, processJevAssessmentQueue]) {
        try { await step(); } catch { console.error('[ai] queue step unavailable'); }
      }
    } finally { busy = false; }
  };
  const timer = setInterval(tick, 1500); timer.unref(); return () => { clearInterval(timer); abortAiRuns(); };
}
