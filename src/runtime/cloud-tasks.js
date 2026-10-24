import { GoogleAuth } from 'google-auth-library';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { validJobKind } from './job-kinds.js';

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const invalid = () => { throw new Error('CLOUD_TASKS_CONFIGURATION_INVALID'); };
export function cloudTasksConfig(env = process.env) {
  if (env.BACKGROUND_EXECUTION_MODE !== 'cloud-tasks') invalid();
  const project = env.GOOGLE_CLOUD_PROJECT;
  const location = env.CLOUD_TASKS_LOCATION;
  const queue = env.CLOUD_TASKS_QUEUE;
  if (!/^[a-z][a-z0-9-]{5,61}[a-z0-9]$/.test(project || '')
    || !/^[a-z]+-[a-z]+\d+$/.test(location || '')
    || !/^[a-z][a-z0-9-]{1,99}$/.test(queue || '')) invalid();
  let url;
  try { url = new URL(env.WORKER_URL); } catch { invalid(); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.run.app') || url.username
    || url.password || url.port || url.pathname !== '/' || url.search || url.hash) invalid();
  const invoker = env.TASK_INVOKER_SERVICE_ACCOUNT;
  const scheduler = env.SCHEDULER_SERVICE_ACCOUNT;
  if (invoker !== `sabi-task-invoker-production@${project}.iam.gserviceaccount.com`
    || scheduler !== `sabi-scheduler-production@${project}.iam.gserviceaccount.com`) invalid();
  return { parent: `projects/${project}/locations/${location}/queues/${queue}`,
    workerUrl: url.origin, invoker, scheduler };
}

export async function enqueueJob(kind, { env = process.env, id = randomUUID(), request, now = Date.now } = {}) {
  if (!validJobKind(kind)) throw new Error('UNKNOWN_BACKGROUND_JOB');
  const config = cloudTasksConfig(env);
  const taskId = createHash('sha256').update(`${kind}:${id}`).digest('hex');
  const task = { name: `${config.parent}/tasks/${taskId}`, dispatchDeadline: '300s',
    httpRequest: { httpMethod: 'POST', url: `${config.workerUrl}/internal/jobs/${kind}`,
      headers: { 'Content-Type': 'application/json' }, body: Buffer.from('{}').toString('base64'),
      oidcToken: { serviceAccountEmail: config.invoker, audience: config.workerUrl } },
    scheduleTime: new Date(now()).toISOString() };
  let unavailable = false;
  try {
    const call = request || (options => auth.request(options));
    await call({ url: `https://cloudtasks.googleapis.com/v2/${config.parent}/tasks`, method: 'POST',
      data: { task }, timeout: 5000, retry: false });
  } catch (error) {
    unavailable = error.response?.status !== 409;
  }
  // Do not attach a provider exception carrying HTTP credentials/body as cause.
  if (unavailable) throw new Error('BACKGROUND_ENQUEUE_UNAVAILABLE');
  return { queued: true };
}

// The domain transaction commits first. A failed wakeup must not turn a saved
// message into an apparent failure; the minute scheduler recovers persisted work.
export async function wakeBackgroundJob(kind, id) {
  if (process.env.BACKGROUND_EXECUTION_MODE !== 'cloud-tasks') return;
  try { await enqueueJob(kind, { id }); }
  catch { console.error('[background] Wakeup unavailable; persisted work awaits scheduled recovery.'); }
}
