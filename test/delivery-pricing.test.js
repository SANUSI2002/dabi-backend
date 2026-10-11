import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIGURATION, normalizeConfiguration, priceDelivery, straightLineKm } from '../src/modules/checkout-pricing/delivery-pricing.js';
import { measure } from '../src/modules/checkout-pricing/distance.js';

const NAIRA = 100;
const config = (overrides = {}) => normalizeConfiguration({ version: 7, deliveryRatePerKmMinor: 200 * NAIRA, platformFeeMinor: 0, ...overrides });
const price = (overrides = {}, input = {}) => priceDelivery({ config: config(overrides), distanceKm: 5, method: 'STRAIGHT_LINE', subtotalMinor: 10_000 * NAIRA, ...input });
const sum = (quote) => quote.lines.reduce((total, line) => total + line.amountMinor, 0);

describe('delivery pricing — the per-kilometre rate', () => {
  it('charges 5 × the rate for 5 km when nothing else is configured (₦200/km → ₦1,000)', () => {
    const quote = price();
    expect(quote.feeMinor).toBe(1_000 * NAIRA);
    expect(quote.lines).toEqual([expect.objectContaining({ code: 'DISTANCE', label: 'Distance 5 km × ₦200/km', amountMinor: 1_000 * NAIRA })]);
    expect(quote).toMatchObject({ distanceKm: 5, billableKm: 5, method: 'STRAIGHT_LINE', ratePerKmMinor: 20_000, pricingVersion: 7, freeDelivery: false });
  });

  it('keeps the platform default (₦600/km, exact distance) when no version was ever configured', () => {
    expect(priceDelivery({ config: DEFAULT_CONFIGURATION, distanceKm: 2.5, method: 'STRAIGHT_LINE', subtotalMinor: 1 }).feeMinor).toBe(150_000);
  });

  it('charges part-kilometres exactly to the kobo, half-up', () => {
    expect(price({}, { distanceKm: 1.2345 }).feeMinor).toBe(24_700); // 1.235 km (metres rounded) × 20,000
    expect(price({ deliveryRatePerKmMinor: 333 }, { distanceKm: 0.0015 }).feeMinor).toBe(1); // 2 m × 333/1000 = 0.666 → 1
    expect(price({}, { distanceKm: 0 }).feeMinor).toBe(0);
  });

  it('rounds the distance as configured before multiplying', () => {
    expect(price({ distanceRounding: 'UP_1_KM' }, { distanceKm: 4.01 }).feeMinor).toBe(5 * 20_000);
    expect(price({ distanceRounding: 'UP_0_1_KM' }, { distanceKm: 4.01 }).feeMinor).toBe(4.1 * 20_000);
    expect(price({ distanceRounding: 'NEAREST_0_1_KM' }, { distanceKm: 4.04 }).feeMinor).toBe(4 * 20_000);
    expect(price({ distanceRounding: 'NEAREST_0_1_KM' }, { distanceKm: 4.05 }).feeMinor).toBe(4.1 * 20_000);
    expect(price({ distanceRounding: 'UP_1_KM' }, { distanceKm: 5 }).feeMinor).toBe(5 * 20_000); // already whole
  });
});

describe('delivery pricing — base fee, included distance, minimum and cap', () => {
  it('adds a base fee and only charges distance beyond what it includes', () => {
    const quote = price({ baseFeeMinor: 500 * NAIRA, includedDistanceKm: 2 });
    expect(quote.lines.map((l) => [l.code, l.amountMinor])).toEqual([['BASE_FEE', 50_000], ['DISTANCE', 60_000]]);
    expect(quote.feeMinor).toBe(110_000);
    expect(price({ baseFeeMinor: 500 * NAIRA, includedDistanceKm: 10 }).feeMinor).toBe(50_000); // never negative distance
  });

  it('lifts short trips to the minimum and caps long ones, showing the adjustment', () => {
    const short = price({ minimumFeeMinor: 1_500 * NAIRA });
    expect(short.feeMinor).toBe(150_000);
    expect(short.lines.at(-1)).toMatchObject({ code: 'MINIMUM_ADJUSTMENT', amountMinor: 50_000 });
    const long = price({ maximumFeeMinor: 600 * NAIRA });
    expect(long.feeMinor).toBe(60_000);
    expect(long.lines.at(-1)).toMatchObject({ code: 'MAXIMUM_ADJUSTMENT', amountMinor: -40_000 });
    expect(price({ minimumFeeMinor: 1_000 * NAIRA }).lines.some((l) => l.code === 'MINIMUM_ADJUSTMENT')).toBe(false); // exactly the minimum
  });
});

describe('delivery pricing — distance bands and zones', () => {
  const bands = [{ fromKm: 0, toKm: 3, ratePerKmMinor: 300 * NAIRA }, { fromKm: 3, toKm: 10, ratePerKmMinor: 150 * NAIRA }, { fromKm: 10, toKm: null, ratePerKmMinor: 100 * NAIRA }];
  it('uses the band the whole distance falls in; a boundary belongs to the next band', () => {
    expect(price({ bands }, { distanceKm: 2.999 }).ratePerKmMinor).toBe(30_000);
    expect(price({ bands }, { distanceKm: 3 }).ratePerKmMinor).toBe(15_000);
    expect(price({ bands }, { distanceKm: 25 })).toMatchObject({ ratePerKmMinor: 10_000, band: { fromKm: 10, toKm: null } });
  });

  const lagos = { id: 'ikeja', name: 'Ikeja', centre: { latitude: 6.6018, longitude: 3.3515 }, radiusKm: 8, ratePerKmMinor: 250 * NAIRA, surchargeMinor: 100 * NAIRA };
  const inIkeja = { latitude: 6.61, longitude: 3.36 };
  it('applies a zone rate and surcharge for addresses inside the zone, and pauses zones', () => {
    const quote = price({ zones: [lagos], bands }, { destination: inIkeja });
    expect(quote).toMatchObject({ ratePerKmMinor: 25_000, zone: { id: 'ikeja', name: 'Ikeja' }, feeMinor: 5 * 25_000 + 10_000 });
    expect(() => price({ zones: [{ ...lagos, serviceable: false }] }, { destination: inIkeja })).toThrow(expect.objectContaining({ code: 'NOT_SERVICEABLE', details: expect.objectContaining({ reason: 'ZONE_PAUSED' }) }));
    expect(() => price({ zones: [lagos], restrictToZones: true }, { destination: { latitude: 9.07, longitude: 7.49 } })).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'OUTSIDE_ZONES' }) }));
  });
});

describe('delivery pricing — order rules, surcharges and rounding', () => {
  it('adds a small-order fee below the threshold, not at it', () => {
    const rules = { smallOrderThresholdMinor: 2_000 * NAIRA, smallOrderFeeMinor: 300 * NAIRA };
    expect(price(rules, { subtotalMinor: 1_999 * NAIRA }).lines.at(-1)).toMatchObject({ code: 'SMALL_ORDER', amountMinor: 30_000 });
    expect(price(rules, { subtotalMinor: 2_000 * NAIRA }).lines.some((l) => l.code === 'SMALL_ORDER')).toBe(false);
  });

  it('adds fixed surcharges and waives everything for free delivery at the threshold', () => {
    const rules = { surcharges: [{ code: 'FUEL', label: 'Fuel surcharge', amountMinor: 150 * NAIRA }], freeDeliveryThresholdMinor: 20_000 * NAIRA };
    const paid = price(rules, { subtotalMinor: 19_999 * NAIRA });
    expect(paid.feeMinor).toBe(115_000);
    const free = price(rules, { subtotalMinor: 20_000 * NAIRA });
    expect(free).toMatchObject({ feeMinor: 0, freeDelivery: true });
    expect(free.lines.at(-1)).toMatchObject({ code: 'FREE_DELIVERY', amountMinor: -115_000 });
  });

  it('rounds the final fee to the configured multiple, half-up, as its own line', () => {
    const quote = price({ feeRoundingMinor: 50 * NAIRA }, { distanceKm: 1.234 }); // 24,680 → 25,000 (₦250)
    expect(quote.feeMinor).toBe(25_000);
    expect(quote.lines.at(-1)).toMatchObject({ code: 'ROUNDING', amountMinor: 320 });
  });

  it('always itemises: the lines add up to the fee', () => {
    for (const overrides of [{}, { baseFeeMinor: 33_333, minimumFeeMinor: 200_000 }, { maximumFeeMinor: 1_000, smallOrderThresholdMinor: 99_999_999, smallOrderFeeMinor: 7 }, { feeRoundingMinor: 1_000, includedDistanceKm: 1.111 }]) {
      for (const distanceKm of [0, 0.7, 3, 12.345]) {
        const quote = price(overrides, { distanceKm });
        expect(sum(quote)).toBe(quote.feeMinor);
        expect(quote.feeMinor).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('delivery pricing — serviceability and invalid input', () => {
  it('serves up to exactly the tier radius and the global maximum, not a metre more', () => {
    expect(price({}, { distanceKm: 10, tierRadiusKm: 10 }).feeMinor).toBe(200_000);
    expect(() => price({}, { distanceKm: 10.001, tierRadiusKm: 10 })).toThrow(expect.objectContaining({ code: 'NOT_SERVICEABLE', details: expect.objectContaining({ reason: 'TIER_RADIUS' }) }));
    expect(() => price({ maxDistanceKm: 15 }, { distanceKm: 15.5 })).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'MAX_DISTANCE' }) }));
  });

  it('refuses a distance that could not be measured', () => {
    for (const distanceKm of [Number.NaN, -1, Infinity]) expect(() => price({}, { distanceKm })).toThrow(expect.objectContaining({ code: 'INVALID_DISTANCE' }));
  });
});

describe('distance measurement', () => {
  const origin = { latitude: 6.5244, longitude: 3.3792 };
  const destination = { latitude: 6.6018, longitude: 3.3515 };
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('measures straight-line distance and labels it so', async () => {
    const result = await measure(config(), origin, destination);
    expect(result).toEqual({ distanceKm: straightLineKm(origin, destination), method: 'STRAIGHT_LINE', fallback: false });
    expect(result.distanceKm).toBeGreaterThan(9);
    expect(result.distanceKm).toBeLessThan(9.2);
  });

  it('refuses missing or impossible coordinates clearly', async () => {
    await expect(measure(config(), { latitude: null, longitude: 3 }, destination)).rejects.toMatchObject({ code: 'INVALID_ORIGIN' });
    await expect(measure(config(), origin, { latitude: 95, longitude: 3 })).rejects.toMatchObject({ code: 'INVALID_DESTINATION' });
  });

  it('never silently switches road distance to straight-line', async () => {
    vi.stubEnv('GOOGLE_ROUTES_API_KEY', '');
    await expect(measure(config({ distanceMethod: 'ROAD' }), origin, destination)).rejects.toMatchObject({ code: 'ROUTE_DISTANCE_UNAVAILABLE' });
    const fallback = await measure(config({ distanceMethod: 'ROAD', roadFallbackToStraightLine: true }), origin, destination);
    expect(fallback).toMatchObject({ method: 'STRAIGHT_LINE', fallback: true, fallbackReason: expect.stringContaining('not configured') });
  });

  it('uses the routing service for road distance, and reports when it fails', async () => {
    vi.stubEnv('GOOGLE_ROUTES_API_KEY', 'test-key-not-real');
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ routes: [{ distanceMeters: 12_345 }] }) }));
    vi.stubGlobal('fetch', fetch);
    expect(await measure(config({ distanceMethod: 'ROAD' }), origin, destination)).toEqual({ distanceKm: 12.345, method: 'ROAD', fallback: false });
    expect(fetch.mock.calls[0][1].headers['X-Goog-FieldMask']).toBe('routes.distanceMeters');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })));
    await expect(measure(config({ distanceMethod: 'ROAD' }), origin, destination)).rejects.toMatchObject({ code: 'ROUTE_DISTANCE_UNAVAILABLE', message: expect.stringContaining('503') });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ routes: [] }) })));
    await expect(measure(config({ distanceMethod: 'ROAD' }), origin, destination)).rejects.toMatchObject({ message: expect.stringContaining('no driving route') });
  });
});
