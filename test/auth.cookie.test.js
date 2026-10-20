import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearRefreshCookie, readRefreshCookie, requireTrustedOrigin, setRefreshCookie } from '../src/modules/auth/auth.cookie.js';

afterEach(() => vi.unstubAllEnvs());

const request = (headers) => ({ get: (name) => headers[name] });

describe('deployment-specific refresh cookies', () => {
  it.each([
    ['development', '', 'sabi-refresh', false],
    ['production', '', '__Secure-sabi-refresh', true],
    ['production', 'firebase', '__session', true],
  ])('preserves secure session behavior for %s / %s', (mode, proxy, name, secure) => {
    vi.stubEnv('NODE_ENV', mode);
    vi.stubEnv('AUTH_HOSTING_PROXY', proxy);
    vi.stubEnv('AUTH_COOKIE_DOMAIN', '');
    vi.stubEnv('SESSION_DAYS', '7');
    const res = { cookie: vi.fn(), clearCookie: vi.fn() };
    setRefreshCookie(res, 'synthetic-token');
    expect(res.cookie).toHaveBeenCalledWith(name, 'synthetic-token', {
      httpOnly: true, secure, sameSite: 'lax', path: '/api/v1/auth', maxAge: 7 * 86_400_000,
    });
    clearRefreshCookie(res);
    expect(res.clearCookie).toHaveBeenCalledWith(name, {
      httpOnly: true, secure, sameSite: 'lax', path: '/api/v1/auth',
    });
    expect(readRefreshCookie(request({ cookie: `other=ignored; ${name}=synthetic%2Dtoken` }))).toBe('synthetic-token');
  });

  it('does not accept legacy or prefixed lookalike cookies in Firebase mode', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_HOSTING_PROXY', 'firebase');
    expect(readRefreshCookie(request({ cookie: '__Secure-sabi-refresh=old; prefix__session=wrong' }))).toBeUndefined();
  });

  it.each([undefined, 'https://evil.example.test', 'https://sabi.example.test.evil.test'])('rejects an untrusted Firebase cookie request from %s', (origin) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_HOSTING_PROXY', 'firebase');
    vi.stubEnv('CLIENT_URLS', 'https://sabi.example.test');
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    requireTrustedOrigin(request({ cookie: '__session=synthetic', origin }), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows only the exact trusted origin with a Firebase refresh cookie', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_HOSTING_PROXY', 'firebase');
    vi.stubEnv('CLIENT_URLS', 'https://sabi.example.test');
    const next = vi.fn();
    requireTrustedOrigin(request({ cookie: '__session=synthetic', origin: 'https://sabi.example.test' }), {}, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
