// How far a delivery travels, and how that was measured. The method is always reported with the
// distance, so a quote never presents a straight-line estimate as road distance.
//
//   STRAIGHT_LINE  great-circle distance; always available.
//   ROAD           driving distance from the Google Routes API (computeRoutes). Needs
//                  GOOGLE_ROUTES_API_KEY. When it is not configured or does not answer, the quote
//                  fails with ROUTE_DISTANCE_UNAVAILABLE — unless the pricing version explicitly allows
//                  falling back to straight-line, in which case the quote records that it did.
import { setTimeout, clearTimeout } from 'node:timers';
import { straightLineKm } from './delivery-pricing.js';

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const TIMEOUT_MS = 4000;
const fail = (code, message) => Object.assign(new Error(code), { code, message });

export const roadRoutingConfigured = () => Boolean(process.env.GOOGLE_ROUTES_API_KEY);

async function roadKm(origin, destination) {
  const key = process.env.GOOGLE_ROUTES_API_KEY;
  if (!key) throw fail('ROUTE_DISTANCE_UNAVAILABLE', 'Road distance is not configured on this server.');
  const controller = new globalThis.AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const point = (p) => ({ location: { latLng: { latitude: p.latitude, longitude: p.longitude } } });
    const response = await globalThis.fetch(ROUTES_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'routes.distanceMeters' },
      body: JSON.stringify({ origin: point(origin), destination: point(destination), travelMode: 'DRIVE' }),
    });
    if (!response.ok) throw fail('ROUTE_DISTANCE_UNAVAILABLE', `The routing service answered ${response.status}.`);
    const metres = (await response.json())?.routes?.[0]?.distanceMeters;
    if (!Number.isFinite(metres)) throw fail('ROUTE_DISTANCE_UNAVAILABLE', 'The routing service found no driving route.');
    return metres / 1000;
  } catch (error) {
    if (error.code === 'ROUTE_DISTANCE_UNAVAILABLE') throw error;
    throw fail('ROUTE_DISTANCE_UNAVAILABLE', error.name === 'AbortError' ? 'The routing service did not answer in time.' : 'The routing service could not be reached.');
  } finally {
    clearTimeout(timer);
  }
}

const validPoint = (p) => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180;

/**
 * Measures origin → destination with the configuration's method.
 * @returns {Promise<{ distanceKm: number, method: 'STRAIGHT_LINE'|'ROAD', fallback: boolean, fallbackReason?: string }>}
 */
export async function measure(config, origin, destination) {
  if (!validPoint(origin)) throw fail('INVALID_ORIGIN', 'The pharmacy location is not recorded, so delivery cannot be priced.');
  if (!validPoint(destination)) throw fail('INVALID_DESTINATION', 'The delivery location is not valid.');
  if (config.distanceMethod !== 'ROAD') return { distanceKm: straightLineKm(origin, destination), method: 'STRAIGHT_LINE', fallback: false };
  try {
    return { distanceKm: await roadKm(origin, destination), method: 'ROAD', fallback: false };
  } catch (error) {
    if (!config.roadFallbackToStraightLine) throw error;
    return { distanceKm: straightLineKm(origin, destination), method: 'STRAIGHT_LINE', fallback: true, fallbackReason: error.message };
  }
}
