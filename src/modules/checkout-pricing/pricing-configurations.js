// Delivery pricing versions: stored, scheduled, cancelled — never edited. The active version is the
// most recent one whose effective time has passed and that was not cancelled; a version scheduled for
// later takes over by itself at its effective time. Orders keep the version (and itemised quote) they
// were priced with, so a new version never changes an order already placed.
import prisma from '../../config/db.js';
import { platformAccessFor } from '../identity/identity.service.js';
import { DEFAULT_CONFIGURATION, normalizeConfiguration, priceDelivery } from './delivery-pricing.js';
import { measure } from './distance.js';

const fail = (code, message, details) => Object.assign(new Error(code), { code, message: message ?? code, details });

/** Fields a new version carries; anything left out is copied from the version it replaces. */
export const VERSION_FIELDS = [
  'platformFeeMinor', 'deliveryRatePerKmMinor', 'currency', 'baseFeeMinor', 'includedDistanceKm', 'minimumFeeMinor', 'maximumFeeMinor',
  'maxDistanceKm', 'distanceMethod', 'roadFallbackToStraightLine', 'distanceRounding', 'feeRoundingMinor', 'bands', 'zones', 'restrictToZones',
  'freeDeliveryThresholdMinor', 'smallOrderThresholdMinor', 'smallOrderFeeMinor', 'surcharges', 'quoteTtlMinutes',
];

const activeWhere = (at) => ({ effectiveAt: { lte: at }, cancelledAt: null });

/** The version in force at `at` (default now), normalized; the built-in default when none exists. */
export async function activeConfiguration(db = prisma, at = new Date()) {
  const row = await db.checkoutPricingConfiguration.findFirst({ where: activeWhere(at), orderBy: [{ effectiveAt: 'desc' }, { version: 'desc' }] });
  return row ? normalizeConfiguration(row) : DEFAULT_CONFIGURATION;
}

/** Who may change commercial pricing: platform staff with platform.pricing.manage, or the legacy SUPER_ADMIN role. */
export async function canManagePricing(userId, db = prisma) {
  const legacy = await db.userRole.findFirst({ where: { userId, role: 'SUPER_ADMIN' }, select: { id: true } });
  if (legacy) return true;
  try {
    return (await platformAccessFor(userId)).permissions.includes('platform.pricing.manage');
  } catch {
    return false;
  }
}

/** Every version, newest first, with who created or cancelled it and whether it is active, scheduled or superseded. */
export async function listConfigurations(db = prisma, now = new Date()) {
  const rows = await db.checkoutPricingConfiguration.findMany({ orderBy: [{ version: 'desc' }] });
  const active = await activeConfiguration(db, now);
  const people = [...new Set(rows.flatMap((r) => [r.createdByUserId, r.cancelledByUserId]).filter(Boolean))];
  const names = new Map((people.length ? await db.user.findMany({ where: { id: { in: people } }, select: { id: true, full_name: true, email: true } }) : [])
    .map((u) => [u.id, u.full_name || u.email]));
  return rows.map((row) => {
    const config = normalizeConfiguration(row);
    const state = row.cancelledAt ? 'CANCELLED' : row.version === active.version ? 'ACTIVE' : row.effectiveAt > now ? 'SCHEDULED' : 'SUPERSEDED';
    return { ...config, state, createdByName: names.get(row.createdByUserId) ?? null, cancelledByName: names.get(row.cancelledByUserId) ?? null };
  });
}

function checkRules(values) {
  const bands = values.bands ?? [];
  const sorted = [...bands].sort((a, b) => a.fromKm - b.fromKm);
  for (let i = 0; i < sorted.length; i += 1) {
    const band = sorted[i];
    if (band.toKm !== null && band.toKm !== undefined && band.toKm <= band.fromKm) throw fail('INVALID_PRICING', `Distance band ${band.fromKm}–${band.toKm} km ends before it starts.`);
    const next = sorted[i + 1];
    if (next && (band.toKm === null || band.toKm === undefined || band.toKm > next.fromKm)) throw fail('INVALID_PRICING', 'Distance bands overlap; each distance must fall in at most one band.');
  }
  const ids = new Set();
  for (const zone of values.zones ?? []) {
    if (ids.has(zone.id)) throw fail('INVALID_PRICING', `Two zones share the id "${zone.id}".`);
    ids.add(zone.id);
  }
  if (values.restrictToZones && !(values.zones ?? []).some((z) => z.serviceable !== false)) throw fail('INVALID_PRICING', 'Delivery is limited to zones, but no zone is serviceable.');
  if (values.maximumFeeMinor !== null && values.maximumFeeMinor !== undefined && values.maximumFeeMinor < (values.minimumFeeMinor ?? 0)) throw fail('INVALID_PRICING', 'The fee cap is below the minimum fee.');
  if (values.smallOrderThresholdMinor && !values.smallOrderFeeMinor) throw fail('INVALID_PRICING', 'A small-order threshold needs a small-order fee.');
}

/**
 * Creates the next version. `values` may change any subset of VERSION_FIELDS; the rest are copied from
 * the version currently in force. effectiveAt defaults to now; a later time schedules it.
 * @returns {{ before, after }} the version replaced and the new one, both normalized.
 */
export async function createConfiguration(db, actorUserId, values, { reason, effectiveAt } = {}) {
  if (!reason || reason.trim().length < 5) throw fail('REASON_REQUIRED', 'Say why the pricing is changing.');
  const now = new Date();
  const when = effectiveAt ? new Date(effectiveAt) : now;
  if (when.getTime() < now.getTime() - 60_000) throw fail('INVALID_PRICING', 'A new version cannot take effect in the past.');
  const before = await activeConfiguration(db, now);
  const next = Object.fromEntries(VERSION_FIELDS.map((field) => [field, values[field] !== undefined ? values[field] : before[field]]));
  checkRules(next);
  // Serialize version numbers: one new version at a time.
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('checkout_pricing_configurations'))::text AS locked`;
  const latest = await db.checkoutPricingConfiguration.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
  const row = await db.checkoutPricingConfiguration.create({
    data: { ...next, version: (latest?.version ?? 0) + 1, effectiveAt: when, createdByUserId: actorUserId, changeReason: reason.trim() },
  });
  return { before, after: normalizeConfiguration(row) };
}

/** Cancels a version that has not taken effect yet (a version in force can only be replaced). */
export async function cancelScheduled(db, actorUserId, version) {
  const row = await db.checkoutPricingConfiguration.findUnique({ where: { version } });
  if (!row) throw fail('NOT_FOUND', 'Pricing version not found.');
  if (row.cancelledAt) throw fail('INVALID_STATE', 'This version is already cancelled.');
  if (row.effectiveAt <= new Date()) throw fail('INVALID_STATE', 'This version has already taken effect; create a new version to change pricing.');
  const updated = await db.checkoutPricingConfiguration.update({ where: { version }, data: { cancelledAt: new Date(), cancelledByUserId: actorUserId } });
  return normalizeConfiguration(updated);
}

/**
 * The authoritative delivery quote for one pharmacy: measures the distance with the configuration's
 * method, prices it, and stamps when and with what it was priced.
 */
export async function quoteDelivery({ config, origin, destination, subtotalMinor, tierRadiusKm = null, now = new Date() }) {
  const measured = await measure(config, origin, destination);
  const priced = priceDelivery({ config, distanceKm: measured.distanceKm, method: measured.method, destination, subtotalMinor, tierRadiusKm });
  return {
    ...priced,
    ...(measured.fallback ? { methodFallback: { requested: 'ROAD', used: 'STRAIGHT_LINE', reason: measured.fallbackReason } } : {}),
    quotedAt: now.toISOString(),
  };
}
