import { Worker } from 'node:worker_threads';
import { URL } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import { aiError } from './ai.config.js';

// Untrusted PDF parsing is isolated from the API/queue heap and forcibly bounded.
export function inspectAiDocument(bytes, contentType) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./ai.document-parser.js', import.meta.url), {
      workerData: { bytes, contentType }, resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (result, failed = false) => {
      if (settled) return; settled = true; clearTimeout(timer); void worker.terminate();
      if (failed) reject(aiError(422, 'AI_DOCUMENT_UNSUPPORTED', 'Use a readable, unencrypted PDF (up to 20 pages) or a PNG/JPEG image.'));
      else resolve(result);
    };
    const timer = setTimeout(() => finish(null, true), 5000);
    worker.once('message', (value) => finish(value, !value?.pageCount));
    worker.once('error', () => finish(null, true));
    worker.once('exit', () => finish(null, true));
  });
}
