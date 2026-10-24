// Run only from a reviewed, pinned backend checkout in authorised Cloud Shell.
// No secret values are read by this script, stored in files, or passed to Docker.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const project = 'project-2dfff4eb-ff04-40b1-aff';
const region = 'us-east1';
const registry = `${region}-docker.pkg.dev/${project}/sabi-production-images`;
const settings = JSON.parse(readFileSync(join(root, 'ops/google-cloud/production-env.json'), 'utf8'));
// Opt-in only: normal deployments retain the production callback configuration.
// The one exact preview origin and temporary callback bases were owner-approved.
if (process.argv.includes('--acceptance-preview')) {
  const preview = JSON.parse(readFileSync(join(root, 'ops/google-cloud/acceptance-preview.json'), 'utf8'));
  Object.assign(settings, preview, { CLIENT_URLS: `${settings.CLIENT_URLS},${preview.CLIENT_URL}` });
}
const execute = (command, args, capture = false) => {
  const result = spawnSync(command, args, { cwd: root, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed; no automatic promotion follows.`);
  return capture ? result.stdout.trim() : undefined;
};
const cloud = (args, capture = false) => execute('gcloud', [...args, `--project=${project}`, '--quiet'], capture);
const revision = execute('git', ['rev-parse', 'HEAD'], true);
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Pinned Git revision is required.');
const tag = revision.slice(0, 12);
const image = kind => `${registry}/${kind}:${tag}`;
const secretBindings = {
  RESEND_API_KEY: ['sabi-prod-resend-api-key', 'both'],
  CLOUDMERSIVE_API_KEY: ['sabi-prod-cloudmersive-api-key', 'both'],
  DAILY_API_KEY: ['sabi-prod-daily-api-key', 'both'],
  GOOGLE_OAUTH_CLIENT_ID: ['sabi-prod-google-oauth-client-id', 'api'],
  GOOGLE_OAUTH_CLIENT_SECRET: ['sabi-prod-google-oauth-client-secret', 'api'],
  JWT_SECRET: ['sabi-prod-jwt-secret', 'api'],
  JWT_REFRESH_SECRET: ['sabi-prod-jwt-refresh-secret', 'api'],
  RATE_LIMIT_KEY_SECRET: ['sabi-prod-rate-limit-key-secret', 'api'],
  MFA_ENCRYPTION_KEY: ['sabi-prod-mfa-encryption-key', 'api'],
  WEB_PUSH_ACTION_SECRET: ['sabi-prod-web-push-action-secret', 'both'],
  ORDER_DELIVERY_ENCRYPTION_KEY: ['sabi-prod-order-delivery-encryption-key', 'both'],
  EMR_SECRET_KEY: ['sabi-prod-emr-secret-key', 'both'],
  SABI_AI_GATEWAY_SECRET: ['sabi-ai-gateway-secret', 'both'],
  TYPESAFE_API_KEY: ['typesafe-api-key', 'both'],
};
const action = process.argv[2];
if (action === 'build') {
  cloud(['auth', 'configure-docker', `${region}-docker.pkg.dev`]);
  for (const kind of ['api', 'worker']) {
    execute('docker', ['build', '--platform=linux/amd64', '--target', kind, '--tag', image(kind), root]);
    // Cloud Shell's Docker daemon can have a different registry network path
    // from its CLI. Google's pinned registry client uses the existing gcloud
    // credential helper without daemon/network-policy changes or TLS bypasses.
    const archive = join(mkdtempSync(join(tmpdir(), 'sabi-image-')), `${kind}.tar`);
    execute('docker', ['save', '--output', archive, image(kind)]);
    execute('go', ['run', 'github.com/google/go-containerregistry/cmd/crane@v0.22.1', 'push', archive, image(kind)]);
  }
} else if (action === 'api' || action === 'worker') {
  const kind = action;
  const digest = cloud(['artifacts', 'docker', 'images', 'describe', image(kind), '--format=value(image_summary.digest)'], true);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Registry digest is required.');
  const refs = [];
  for (const [name, [id, access]] of Object.entries(secretBindings)) {
    if (access !== 'both' && access !== kind) continue;
    const version = cloud(['secrets', 'versions', 'list', id, '--filter=state=ENABLED', '--sort-by=~createTime', '--limit=1', '--format=value(name)'], true);
    if (!/^\d+$/.test(version)) throw new Error(`An enabled version is required for ${id}.`);
    refs.push(`${name}=${id}:${version}`);
  }
  const directory = mkdtempSync(join(tmpdir(), 'sabi-runtime-env-'));
  const envFile = join(directory, 'environment.json');
  writeFileSync(envFile, JSON.stringify({ ...settings, APP_REVISION: revision,
    CLOUD_SQL_IAM_USER: `sabi-${kind}-production@${project}.iam` }), { mode: 0o600 });
  cloud(['run', 'deploy', `sabi-${kind}-production`, `--region=${region}`,
    `--image=${registry}/${kind}@${digest}`, `--service-account=sabi-${kind}-production@${project}.iam.gserviceaccount.com`,
    '--execution-environment=gen2', '--cpu=1', '--memory=512Mi', '--min=0', '--max=1', '--max-instances=1',
    `--concurrency=${kind === 'api' ? 40 : 2}`, '--timeout=300', '--cpu-throttling', '--ingress=all',
    '--startup-probe=httpGet.path=/healthz/live,initialDelaySeconds=0,periodSeconds=10,timeoutSeconds=2,failureThreshold=24',
    `--env-vars-file=${envFile}`, `--set-secrets=${refs.join(',')}`,
    kind === 'api' ? '--allow-unauthenticated' : '--no-allow-unauthenticated']);
  if (kind === 'worker') {
    for (const name of ['sabi-task-invoker-production', 'sabi-scheduler-production']) {
      cloud(['run', 'services', 'add-iam-policy-binding', 'sabi-worker-production', `--region=${region}`,
        `--member=serviceAccount:${name}@${project}.iam.gserviceaccount.com`, '--role=roles/run.invoker']);
    }
  }
  cloud(['run', 'services', 'describe', `sabi-${kind}-production`, `--region=${region}`,
    '--format=json(status.url,status.conditions,status.latestReadyRevisionName)']);
} else if (action === 'scheduler') {
  const existing = spawnSync('gcloud', ['scheduler', 'jobs', 'describe', 'sabi-production-tick', `--location=${region}`, `--project=${project}`, '--format=value(name)'], { cwd: root, encoding: 'utf8' });
  if (existing.status !== 0 && !/NOT_FOUND/.test(existing.stderr || '')) throw new Error('Cannot inspect Scheduler state.');
  cloud(['scheduler', 'jobs', existing.status === 0 ? 'update' : 'create', 'http', 'sabi-production-tick', `--location=${region}`,
    '--schedule=* * * * *', '--time-zone=Etc/UTC', `--uri=${settings.WORKER_URL}/internal/dispatch`,
    '--http-method=POST', '--message-body={}', `${existing.status === 0 ? '--update-headers' : '--headers'}=Content-Type=application/json`,
    `--oidc-service-account-email=${settings.SCHEDULER_SERVICE_ACCOUNT}`, `--oidc-token-audience=${settings.WORKER_URL}`,
    '--attempt-deadline=60s', '--max-retry-attempts=3', '--min-backoff=10s', '--max-backoff=60s']);
} else {
  throw new Error('Choose build, worker, api or scheduler. Scheduler is activated only after worker checks.');
}
