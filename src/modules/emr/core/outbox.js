// Transactional outbox + webhook delivery.
//
// enqueueEvent() writes the event in the SAME transaction as the change, so an event exists
// if and only if the change committed. A worker then:
//   dispatch  — fans each pending event out to the tenant's matching active subscriptions
//               (one delivery row per subscriber; SKIP LOCKED makes several workers safe);
//   deliver   — claims due deliveries with a short lease, POSTs them OUTSIDE any database
//               transaction (a slow subscriber never holds a connection or a lock), then records
//               the outcome. Failures back off exponentially; after MAX_ATTEMPTS a delivery is DEAD.
// Payloads carry identifiers and codes only — never names, dates of birth or clinical text.
import { createHmac, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { URL } from 'node:url';
import { withWorker } from './db.js';
import { decryptSecret } from './secrets.js';
import { logger } from './logging.js';

export const MAX_ATTEMPTS = 10;
const LEASE_MS = 60_000;
export const backoffMs = (attempts) => Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60 * 1000);

export async function enqueueEvent(tx, context, { type, aggregateType, aggregateId, data = {} }) {
  const id = randomUUID();
  await tx.emrOutboxEvent.create({
    data: {
      id,
      organizationId: context.organizationId,
      eventType: type,
      aggregateType,
      aggregateId,
      payload: { id, type, organizationId: context.organizationId, occurredAt: new Date().toISOString(), aggregate: { type: aggregateType, id: aggregateId }, data },
    },
  });
  return id;
}

export const signPayload = (secret, timestamp, body) => createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

// ---- SSRF protection: subscribers must be public HTTPS endpoints ----
const privateAddress = (address) => {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const lower = address.toLowerCase();
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80') || lower.startsWith('::ffff:');
};

export const allowLocalWebhooks = () => process.env.NODE_ENV !== 'production' && process.env.EMR_WEBHOOK_ALLOW_LOCAL === 'true';

export function validateWebhookUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return 'Webhook URL is not a valid URL.'; }
  if (url.username || url.password) return 'Webhook URL must not contain credentials.';
  if (url.protocol !== 'https:' && !(allowLocalWebhooks() && url.protocol === 'http:')) return 'Webhook URL must use HTTPS.';
  if (!allowLocalWebhooks() && (url.hostname === 'localhost' || (net.isIP(url.hostname) && privateAddress(url.hostname)))) return 'Webhook URL must be a public address.';
  return null;
}

async function resolvesPublic(hostname) {
  if (allowLocalWebhooks()) return true;
  if (net.isIP(hostname)) return !privateAddress(hostname);
  const addresses = await lookup(hostname, { all: true });
  return addresses.length > 0 && addresses.every(({ address }) => !privateAddress(address));
}

// ---- worker steps ----
export async function dispatchPending({ limit = 100 } = {}) {
  return withWorker(async (tx) => {
    const events = await tx.$queryRaw`
      SELECT "id", "organization_id" AS "organizationId", "event_type" AS "eventType"
      FROM "emr_outbox_events" WHERE "status" = 'PENDING'
      ORDER BY "created_at" LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    for (const event of events) {
      const subscriptions = await tx.emrWebhookSubscription.findMany({
        where: { organizationId: event.organizationId, active: true, OR: [{ eventTypes: { has: event.eventType } }, { eventTypes: { has: '*' } }] },
        select: { id: true },
      });
      if (subscriptions.length) {
        await tx.emrWebhookDelivery.createMany({
          data: subscriptions.map((subscription) => ({ organizationId: event.organizationId, subscriptionId: subscription.id, eventId: event.id })),
          skipDuplicates: true,
        });
      }
      await tx.emrOutboxEvent.update({ where: { id: event.id }, data: { status: 'DISPATCHED', dispatchedAt: new Date() } });
    }
    return events.length;
  });
}

async function claimDue(limit) {
  return withWorker(async (tx) => {
    const due = await tx.$queryRaw`
      SELECT "id" FROM "emr_webhook_deliveries"
      WHERE "status" = 'PENDING' AND "next_attempt_at" <= now()
      ORDER BY "next_attempt_at" LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    if (!due.length) return [];
    const ids = due.map((row) => row.id);
    // Lease: push next_attempt_at out so a crashed worker's claim is retried later, not lost.
    await tx.emrWebhookDelivery.updateMany({ where: { id: { in: ids } }, data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + LEASE_MS) } });
    const deliveries = await tx.emrWebhookDelivery.findMany({ where: { id: { in: ids } } });
    const subscriptions = await tx.emrWebhookSubscription.findMany({ where: { id: { in: [...new Set(deliveries.map((d) => d.subscriptionId))] } } });
    const events = await tx.emrOutboxEvent.findMany({ where: { id: { in: [...new Set(deliveries.map((d) => d.eventId))] } } });
    return deliveries.map((delivery) => ({
      delivery,
      subscription: subscriptions.find((s) => s.id === delivery.subscriptionId),
      event: events.find((e) => e.id === delivery.eventId),
    }));
  });
}

async function record(deliveryId, outcome) {
  await withWorker((tx) => tx.emrWebhookDelivery.update({ where: { id: deliveryId }, data: outcome }));
}

export async function deliverDue({ limit = 50, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const claimed = await claimDue(limit);
  let delivered = 0;
  for (const { delivery, subscription, event } of claimed) {
    if (!subscription?.active || !event) {
      await record(delivery.id, { status: 'DEAD', lastError: 'Subscription inactive or event missing' });
      continue;
    }
    const body = JSON.stringify(event.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    let statusCode = null;
    let errorText = null;
    try {
      const { hostname } = new URL(subscription.url);
      if (!await resolvesPublic(hostname)) throw new Error('Subscriber resolves to a private address');
      const response = await fetchImpl(subscription.url, {
        method: 'POST',
        redirect: 'manual',
        signal: globalThis.AbortSignal.timeout(timeoutMs),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Sabi-EMR-Webhooks/1',
          'x-sabi-event': event.eventType,
          'x-sabi-delivery': delivery.id,
          'x-sabi-signature': `t=${timestamp},v1=${signPayload(decryptSecret(subscription.secretCiphertext), timestamp, body)}`,
        },
        body,
      });
      statusCode = response.status;
      if (response.status < 200 || response.status >= 300) errorText = `HTTP ${response.status}`;
    } catch (error) {
      errorText = String(error?.message || error).slice(0, 300);
    }
    if (!errorText) {
      delivered += 1;
      await record(delivery.id, { status: 'DELIVERED', deliveredAt: new Date(), lastStatusCode: statusCode, lastError: null });
    } else {
      const { attempts } = delivery; // already counts this attempt (incremented when claimed)
      const dead = attempts >= MAX_ATTEMPTS;
      await record(delivery.id, { status: dead ? 'DEAD' : 'PENDING', lastStatusCode: statusCode, lastError: errorText, nextAttemptAt: new Date(Date.now() + backoffMs(attempts)) });
      logger.warn('emr.webhook.delivery_failed', { organizationId: delivery.organizationId, deliveryId: delivery.id, attempts, dead, statusCode });
    }
  }
  return { claimed: claimed.length, delivered };
}

export async function purgeExpiredIdempotencyKeys({ olderThanMs = 24 * 60 * 60 * 1000 } = {}) {
  return withWorker((tx) => tx.emrIdempotencyKey.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - olderThanMs) } } }));
}
