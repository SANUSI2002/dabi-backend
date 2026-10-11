// Delivery pricing — the one authoritative calculation, used by the checkout preview, order
// creation and the Command Centre simulator. Pure: give it a configuration, a measured distance and
// the order subtotal; it returns the fee with an itemised breakdown, or throws NOT_SERVICEABLE.
//
// Calculation order (every step is a line in the breakdown, and the lines always add up to the fee):
//   1. Serviceability: distance ≤ the pharmacy tier radius, ≤ the global maximum distance, and inside
//      a serviceable zone when zones are enforced.
//   2. Billable distance = distance − included distance (never below 0), then rounded as configured.
//   3. Rate per km = the matched zone's rate, else the matched distance band's rate, else the base rate.
//   4. Distance charge = billable km × rate, rounded half-up to the kobo.
//   5. + base fee, + zone surcharge.
//   6. Minimum fee lifts the delivery fee up to the minimum; maximum fee caps it.
//   7. + small-order fee (pharmacy subtotal below the threshold), + every fixed surcharge.
//   8. Free delivery (pharmacy subtotal at or above the threshold) waives everything above.
//   9. Final rounding to the configured multiple (e.g. ₦50), half-up — shown as its own line.
// Example: rate ₦200/km, 5 km, nothing else configured → 5 × 20,000 kobo = 100,000 kobo (₦1,000).
//
// All money is integer kobo; distances are kilometres with 3 decimals (metres).

export const DISTANCE_ROUNDING = ['EXACT', 'UP_0_1_KM', 'UP_1_KM', 'NEAREST_0_1_KM'];
export const DISTANCE_METHODS = ['STRAIGHT_LINE', 'ROAD'];

const fail = (code, message, details) => Object.assign(new Error(code), { code, message: message ?? code, details });
const toMetres = (km) => Math.round(Number(km) * 1000);
const km = (metres) => metres / 1000;

/** Great-circle (straight-line) distance in km between two { latitude, longitude } points. */
export function straightLineKm(from, to) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = radians(to.latitude - from.latitude);
  const dLng = radians(to.longitude - from.longitude);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function roundDistance(metres, mode) {
  switch (mode) {
    case 'UP_0_1_KM': return Math.ceil(metres / 100) * 100;
    case 'UP_1_KM': return Math.ceil(metres / 1000) * 1000;
    case 'NEAREST_0_1_KM': return Math.round(metres / 100) * 100;
    default: return metres;
  }
}

const roundTo = (amount, multiple) => (multiple > 1 ? Math.round(amount / multiple) * multiple : amount);

/** The smallest serviceable/unserviceable zone containing the destination, or null. */
function zoneFor(zones, destination) {
  if (!destination) return null;
  const containing = (zones ?? []).filter((zone) => straightLineKm(zone.centre, destination) <= Number(zone.radiusKm));
  return containing.sort((a, b) => Number(a.radiusKm) - Number(b.radiusKm))[0] ?? null;
}

/** The band whose [fromKm, toKm) range holds the distance (toKm null = no upper end). */
function bandFor(bands, metres) {
  return (bands ?? []).find((band) => metres >= toMetres(band.fromKm) && (band.toKm === null || band.toKm === undefined || metres < toMetres(band.toKm))) ?? null;
}

/**
 * @param {object} input
 * @param {object} input.config          A pricing configuration (normalized by normalizeConfiguration).
 * @param {number} input.distanceKm      Measured distance in km.
 * @param {string} input.method          'STRAIGHT_LINE' or 'ROAD' — how the distance was measured.
 * @param {object} [input.destination]   { latitude, longitude } — needed only for zones.
 * @param {number} input.subtotalMinor   The pharmacy's goods subtotal (for small-order / free-delivery rules).
 * @param {number|null} [input.tierRadiusKm] The pharmacy tier's delivery radius, if any.
 */
export function priceDelivery({ config, distanceKm, method, destination, subtotalMinor, tierRadiusKm = null }) {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) throw fail('INVALID_DISTANCE', 'The delivery distance could not be measured.');
  const metres = toMetres(distanceKm);

  // 1. Serviceability
  if (tierRadiusKm !== null && metres > toMetres(tierRadiusKm)) {
    throw fail('NOT_SERVICEABLE', `This pharmacy delivers up to ${tierRadiusKm} km; the address is ${km(metres).toFixed(1)} km away.`, { reason: 'TIER_RADIUS', limitKm: Number(tierRadiusKm) });
  }
  if (config.maxDistanceKm !== null && metres > toMetres(config.maxDistanceKm)) {
    throw fail('NOT_SERVICEABLE', `Sabi delivers up to ${config.maxDistanceKm} km; the address is ${km(metres).toFixed(1)} km away.`, { reason: 'MAX_DISTANCE', limitKm: config.maxDistanceKm });
  }
  const zone = zoneFor(config.zones, destination);
  if (zone && zone.serviceable === false) throw fail('NOT_SERVICEABLE', `Deliveries to ${zone.name} are paused.`, { reason: 'ZONE_PAUSED', zone: zone.name });
  if (config.restrictToZones && !zone) throw fail('NOT_SERVICEABLE', 'The address is outside the areas Sabi currently delivers to.', { reason: 'OUTSIDE_ZONES' });

  // 2. Billable distance
  const billableMetres = roundDistance(Math.max(0, metres - toMetres(config.includedDistanceKm)), config.distanceRounding);

  // 3. Rate
  const band = bandFor(config.bands, metres);
  const rate = zone?.ratePerKmMinor ?? band?.ratePerKmMinor ?? config.deliveryRatePerKmMinor;
  const rateSource = zone?.ratePerKmMinor !== undefined && zone?.ratePerKmMinor !== null ? `zone ${zone.name}` : band ? `band ${band.fromKm}–${band.toKm ?? '∞'} km` : 'standard rate';

  const lines = [];
  const add = (code, label, amountMinor, detail = undefined) => { if (amountMinor !== 0) lines.push({ code, label, amountMinor, ...(detail ? { detail } : {}) }); };

  // 4–5. Distance charge, base fee, zone surcharge
  const distanceCharge = Math.round((billableMetres * rate) / 1000);
  add('BASE_FEE', 'Base delivery fee', config.baseFeeMinor);
  add('DISTANCE', `Distance ${km(billableMetres).toFixed(billableMetres % 1000 === 0 ? 0 : 3)} km × ₦${(rate / 100).toLocaleString('en-NG')}/km`, distanceCharge,
    { billableKm: km(billableMetres), ratePerKmMinor: rate, rateSource });
  if (zone?.surchargeMinor) add('ZONE_SURCHARGE', `${zone.name} surcharge`, zone.surchargeMinor);
  let deliveryFee = lines.reduce((sum, line) => sum + line.amountMinor, 0);

  // 6. Minimum / maximum
  if (deliveryFee < config.minimumFeeMinor) { add('MINIMUM_ADJUSTMENT', 'Minimum delivery fee', config.minimumFeeMinor - deliveryFee); deliveryFee = config.minimumFeeMinor; }
  if (config.maximumFeeMinor !== null && deliveryFee > config.maximumFeeMinor) add('MAXIMUM_ADJUSTMENT', 'Delivery fee cap', config.maximumFeeMinor - deliveryFee);

  // 7. Small order, fixed surcharges
  if (config.smallOrderThresholdMinor !== null && subtotalMinor < config.smallOrderThresholdMinor) add('SMALL_ORDER', 'Small order fee', config.smallOrderFeeMinor);
  for (const surcharge of config.surcharges ?? []) add(`SURCHARGE_${surcharge.code}`, surcharge.label, surcharge.amountMinor);

  // 8. Free delivery
  let total = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const free = config.freeDeliveryThresholdMinor !== null && subtotalMinor >= config.freeDeliveryThresholdMinor;
  if (free && total > 0) { add('FREE_DELIVERY', `Free delivery on orders of ₦${(config.freeDeliveryThresholdMinor / 100).toLocaleString('en-NG')} or more`, -total); total = 0; }

  // 9. Final rounding
  const rounded = roundTo(total, config.feeRoundingMinor);
  add('ROUNDING', 'Rounding', rounded - total);

  const feeMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  if (feeMinor !== rounded || feeMinor < 0) throw fail('PRICING_INCONSISTENT', 'The delivery price could not be calculated consistently.');
  return {
    feeMinor,
    currency: config.currency,
    distanceKm: km(metres),
    billableKm: km(billableMetres),
    method,
    ratePerKmMinor: rate,
    zone: zone ? { id: zone.id, name: zone.name } : null,
    band: band ? { fromKm: band.fromKm, toKm: band.toKm ?? null } : null,
    freeDelivery: free,
    lines,
    pricingVersion: config.version,
  };
}

const number = (value, fallback = null) => (value === null || value === undefined ? fallback : Number(value));

/** Turns a stored configuration row (or the built-in default) into what priceDelivery expects. */
export function normalizeConfiguration(row) {
  return {
    version: row.version,
    currency: row.currency ?? 'NGN',
    effectiveAt: row.effectiveAt ?? null,
    platformFeeMinor: row.platformFeeMinor ?? 0,
    deliveryRatePerKmMinor: row.deliveryRatePerKmMinor,
    baseFeeMinor: row.baseFeeMinor ?? 0,
    includedDistanceKm: number(row.includedDistanceKm, 0),
    minimumFeeMinor: row.minimumFeeMinor ?? 0,
    maximumFeeMinor: row.maximumFeeMinor ?? null,
    maxDistanceKm: number(row.maxDistanceKm),
    distanceMethod: row.distanceMethod ?? 'STRAIGHT_LINE',
    roadFallbackToStraightLine: row.roadFallbackToStraightLine ?? false,
    distanceRounding: row.distanceRounding ?? 'EXACT',
    feeRoundingMinor: row.feeRoundingMinor ?? 1,
    bands: (row.bands ?? []).map((b) => ({ fromKm: Number(b.fromKm), toKm: b.toKm === null || b.toKm === undefined ? null : Number(b.toKm), ratePerKmMinor: b.ratePerKmMinor })),
    zones: (row.zones ?? []).map((z) => ({ ...z, radiusKm: Number(z.radiusKm), centre: { latitude: Number(z.centre.latitude), longitude: Number(z.centre.longitude) } })),
    restrictToZones: row.restrictToZones ?? false,
    freeDeliveryThresholdMinor: row.freeDeliveryThresholdMinor ?? null,
    smallOrderThresholdMinor: row.smallOrderThresholdMinor ?? null,
    smallOrderFeeMinor: row.smallOrderFeeMinor ?? 0,
    surcharges: row.surcharges ?? [],
    quoteTtlMinutes: row.quoteTtlMinutes ?? 15,
    changeReason: row.changeReason ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: row.createdAt ?? null,
    cancelledAt: row.cancelledAt ?? null,
  };
}

/** What the platform charged before any version was configured (kept so old behaviour is preserved). */
export const DEFAULT_CONFIGURATION = normalizeConfiguration({ version: 0, platformFeeMinor: 0, deliveryRatePerKmMinor: 60000, currency: 'NGN', effectiveAt: null });
