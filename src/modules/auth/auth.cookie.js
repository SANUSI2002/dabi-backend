const cookieName = () => process.env.NODE_ENV === 'production' ? '__Secure-sabi-refresh' : 'sabi-refresh';
const allowedOrigins = () => (process.env.CLIENT_URLS || process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',').map((origin) => origin.trim()).filter(Boolean);

export const browserRequest = (req) => req.get('x-sabi-client') === 'browser';
export const readRefreshCookie = (req) => {
  const name = cookieName();
  const cookie = req.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : undefined;
};
export const requireTrustedOrigin = (req, res, next) => {
  if (!readRefreshCookie(req) && !browserRequest(req)) return next();
  const origin = req.get('origin');
  if (!origin || !allowedOrigins().includes(origin)) return res.status(403).json({ status: 'error', message: 'Request origin denied' });
  return next();
};
const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/api/v1/auth',
  ...(process.env.AUTH_COOKIE_DOMAIN ? { domain: process.env.AUTH_COOKIE_DOMAIN } : {}),
});
export const setRefreshCookie = (res, token) => res.cookie(cookieName(), token, { ...cookieOptions(), maxAge: Math.min(30, Math.max(1, Number(process.env.SESSION_DAYS) || 7)) * 86_400_000 });
export const clearRefreshCookie = (res) => res.clearCookie(cookieName(), cookieOptions());
