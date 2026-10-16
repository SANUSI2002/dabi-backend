// Google and Apple sign-in. The browser never handles a client secret: Google hands it a one-time
// authorization code that only this server can exchange (with GOOGLE_OAUTH_CLIENT_SECRET), and Apple
// hands it a signed identity token bound to a nonce this server issued. Either way the identity we act
// on comes from a token whose signature, issuer, audience and expiry this server checked against the
// provider's published keys.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

export const GOOGLE = 'GOOGLE';
export const APPLE = 'APPLE';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const APPLE_ISSUER = 'https://appleid.apple.com';
const GOOGLE_KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const NONCE_TTL_MS = 10 * 60_000;
const SIGNUP_TTL_SECONDS = 10 * 60;

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

export const googleConfig = () => {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
};
export const appleConfig = () => {
  const clientId = process.env.APPLE_SERVICES_ID?.trim();
  const redirectUri = process.env.APPLE_REDIRECT_URI?.trim();
  return clientId && redirectUri ? { clientId, redirectUri } : null;
};
/** What the sign-in pages may show. Only public identifiers, never secrets. */
export const publicProviders = () => {
  const google = googleConfig();
  const apple = appleConfig();
  return { google: google ? { clientId: google.clientId } : null, apple: apple ? { clientId: apple.clientId, redirectUri: apple.redirectUri } : null };
};

// ---- provider signing keys ------------------------------------------------------------------------
// Cached per the provider's Cache-Control; refetched (at most once a minute) when a token names a key
// we have not seen, which is how both providers roll their keys.
const keyCache = new Map();
export const resetSocialKeyCache = () => keyCache.clear();

async function signingKey(url, kid) {
  const now = Date.now();
  let entry = keyCache.get(url);
  const fresh = entry && entry.expiresAt > now;
  if (!fresh || (!entry.keys.has(kid) && now - entry.fetchedAt > 60_000)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw fail(503, 'SOCIAL_PROVIDER_UNAVAILABLE', 'Sign-in with this provider is temporarily unavailable. Please try again.');
    const body = await response.json();
    const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') || '')?.[1]) || 3600;
    const keys = new Map((body.keys || []).filter((k) => k.kty === 'RSA' && k.kid).map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })]));
    entry = { keys, fetchedAt: now, expiresAt: now + Math.min(maxAge, 86_400) * 1000 };
    keyCache.set(url, entry);
  }
  const key = entry.keys.get(kid);
  if (!key) throw fail(401, 'SOCIAL_TOKEN_INVALID', 'We could not confirm that sign-in. Please try again.');
  return key;
}

async function verifyIdToken(token, { keysUrl, issuer, audience }) {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded?.header?.kid || decoded.header.alg !== 'RS256') throw fail(401, 'SOCIAL_TOKEN_INVALID', 'We could not confirm that sign-in. Please try again.');
  const key = await signingKey(keysUrl, decoded.header.kid);
  try {
    return jwt.verify(token, key, { algorithms: ['RS256'], issuer, audience, clockTolerance: 60 });
  } catch {
    throw fail(401, 'SOCIAL_TOKEN_INVALID', 'We could not confirm that sign-in. Please try again.');
  }
}

const verified = (value) => value === true || value === 'true';

// ---- nonces (Apple) -------------------------------------------------------------------------------
// Stateless: random + expiry, signed with a key derived from JWT_SECRET. Apple copies it into the token,
// so a token minted for some other site or session cannot be replayed here.
const nonceKey = () => crypto.createHash('sha256').update(`social-nonce:${process.env.JWT_SECRET || ''}`).digest();
const mac = (value) => crypto.createHmac('sha256', nonceKey()).update(value).digest('base64url');
export function issueNonce(now = Date.now()) {
  const body = `${crypto.randomBytes(18).toString('base64url')}.${now + NONCE_TTL_MS}`;
  return `${body}.${mac(body)}`;
}
export function nonceIsValid(nonce, now = Date.now()) {
  const parts = String(nonce || '').split('.');
  if (parts.length !== 3) return false;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(mac(body));
  const given = Buffer.from(parts[2]);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) && Number(parts[1]) > now;
}
const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');

// ---- providers ------------------------------------------------------------------------------------
/** Exchanges a Google one-time code (popup flow, redirect_uri "postmessage") for a verified identity. */
export async function googleIdentity(code) {
  const config = googleConfig();
  if (!config) throw fail(503, 'SOCIAL_PROVIDER_NOT_CONFIGURED', 'Google sign-in is not available yet.');
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: 'postmessage', grant_type: 'authorization_code' }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.id_token) {
    if (response.status >= 500) throw fail(503, 'SOCIAL_PROVIDER_UNAVAILABLE', 'Google sign-in is temporarily unavailable. Please try again.');
    throw fail(401, 'SOCIAL_TOKEN_INVALID', 'Google could not confirm that sign-in. Please try again.');
  }
  const claims = await verifyIdToken(body.id_token, { keysUrl: GOOGLE_KEYS_URL, issuer: GOOGLE_ISSUERS, audience: config.clientId });
  return {
    provider: GOOGLE, subject: String(claims.sub), email: claims.email ? String(claims.email).toLowerCase() : null,
    emailVerified: verified(claims.email_verified), firstName: claims.given_name || null, lastName: claims.family_name || null,
  };
}

/** Checks an Apple identity token. Apple only sends the person's name to the browser, once, on first sign-in. */
export async function appleIdentity(idToken, nonce, { firstName, lastName } = {}) {
  const config = appleConfig();
  if (!config) throw fail(503, 'SOCIAL_PROVIDER_NOT_CONFIGURED', 'Apple sign-in is not available yet.');
  if (!nonceIsValid(nonce)) throw fail(401, 'SOCIAL_TOKEN_INVALID', 'That Apple sign-in took too long. Please try again.');
  const claims = await verifyIdToken(idToken, { keysUrl: APPLE_KEYS_URL, issuer: APPLE_ISSUER, audience: config.clientId });
  if (claims.nonce !== nonce && claims.nonce !== sha256Hex(nonce)) throw fail(401, 'SOCIAL_TOKEN_INVALID', 'We could not confirm that sign-in. Please try again.');
  return {
    provider: APPLE, subject: String(claims.sub), email: claims.email ? String(claims.email).toLowerCase() : null,
    emailVerified: verified(claims.email_verified), firstName: firstName?.trim() || null, lastName: lastName?.trim() || null,
  };
}

// ---- consent hand-off -----------------------------------------------------------------------------
// A new person must accept the terms before an account exists. The checked identity is carried for a
// few minutes in a token only this server can sign, so the provider prompt is not shown twice.
const signupKey = () => `social-signup:${process.env.JWT_SECRET || ''}`;
export const signupToken = (identity) => jwt.sign(
  { provider: identity.provider, sub: identity.subject, email: identity.email, emailVerified: identity.emailVerified, firstName: identity.firstName, lastName: identity.lastName },
  signupKey(), { algorithm: 'HS256', expiresIn: SIGNUP_TTL_SECONDS, audience: 'sabi-social-signup' },
);
export function identityFromSignupToken(token) {
  try {
    const c = jwt.verify(token, signupKey(), { algorithms: ['HS256'], audience: 'sabi-social-signup' });
    return { provider: c.provider, subject: c.sub, email: c.email, emailVerified: c.emailVerified, firstName: c.firstName, lastName: c.lastName };
  } catch {
    throw fail(401, 'SOCIAL_SIGNUP_EXPIRED', 'That sign-up took too long. Please choose Google or Apple again.');
  }
}
