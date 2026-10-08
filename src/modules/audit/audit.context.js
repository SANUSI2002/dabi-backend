// Who, where and on which device: the request details stored with an audit entry.
//
// Location is approximate and comes from the edge network in front of the API (Vercel adds the
// x-vercel-ip-* headers when it forwards a request). It is informational: a client calling the API
// directly could send its own values, so it is never used for access decisions.
import { AsyncLocalStorage } from 'node:async_hooks';

const requests = new AsyncLocalStorage();

/** Runs the rest of the request with its details available to recordAudit() anywhere below. */
export const auditRequestScope = (req, res, next) => requests.run({ req }, next);
export const currentRequest = () => requests.getStore()?.req ?? null;

/** "Chrome on Android" from a user-agent string; null when there is none. */
export function deviceLabel(userAgent = '') {
  const ua = String(userAgent);
  if (!ua) return null;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return (browser && os ? `${browser} on ${os}` : browser || os || 'Unknown browser').slice(0, 160);
}

const header = (req, name) => String(req.get?.(name) ?? req.headers?.[name] ?? '').trim();

export function requestLocation(req) {
  const country = header(req, 'x-vercel-ip-country').toUpperCase();
  const region = header(req, 'x-vercel-ip-country-region').toUpperCase();
  let city = header(req, 'x-vercel-ip-city');
  try { city = decodeURIComponent(city); } catch { city = ''; }
  return {
    country: /^[A-Z]{2}$/.test(country) ? country : null,
    region: /^[A-Z0-9]{1,3}$/.test(region) ? region : null,
    city: city && city.length <= 120 && !/[<>{}]/.test(city) ? city : null,
  };
}

export function requestContext(req) {
  if (!req) return {};
  const ip = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 64);
  return { ipAddress: ip || null, device: deviceLabel(header(req, 'user-agent')), ...requestLocation(req) };
}

/** Shown to the account holder only: enough to recognise a network, not to locate a household. */
export function maskIp(ip) {
  if (!ip) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split('.').slice(0, 2).join('.') + '.x.x';
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':…';
  return null;
}
