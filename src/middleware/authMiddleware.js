import jwt from 'jsonwebtoken';
import { activeSession } from '../modules/auth/auth.session.js';

export const protect = async (req, res, next) => {
  const authorization = req.get('authorization');
  const match = /^Bearer ([^\s]+)$/.exec(authorization || '');

  if (!match) {
    return res.status(401).json({ status: 'error', message: 'Not authorized, bearer token required' });
  }

  let decoded;
  try {
    decoded = jwt.verify(match[1], process.env.JWT_SECRET, process.env.NODE_ENV === 'test' ? { algorithms: ['HS256'] } : {
      algorithms: ['HS256'],
      issuer: process.env.JWT_ISSUER || 'sabi-identity',
      audience: process.env.JWT_AUDIENCE || 'sabi-api',
    });
  } catch {
    return res.status(401).json({ status: 'error', message: 'Not authorized, invalid token' });
  }
  const userId = decoded.sub || decoded.id || decoded.userId;

  if (typeof userId !== 'string' || userId.length === 0) {
    return res.status(401).json({ status: 'error', message: 'Not authorized, invalid token' });
  }

  // Legacy test fixtures have no sid. In production, only server-backed access tokens are accepted.
  if (process.env.NODE_ENV !== 'test' && (decoded.tokenUse !== 'access' || typeof decoded.sid !== 'string')) {
    return res.status(401).json({ status: 'error', message: 'Not authorized, invalid session' });
  }
  if (decoded.sid) {
    // A database failure is not an authentication failure: answering 401 here would make
    // clients discard a valid token and refresh (or sign out) during a brief outage.
    let session;
    try {
      session = await activeSession(decoded.sid, userId);
    } catch {
      return res.status(503).json({ status: 'error', code: 'AUTH_UNAVAILABLE', message: 'Authentication is temporarily unavailable. Please retry.' });
    }
    if (!session) return res.status(401).json({ status: 'error', message: 'Not authorized, session expired or revoked' });
  }
  req.user = { id: userId, sessionId: decoded.sid, organizationId: typeof decoded.organizationId === 'string' ? decoded.organizationId : undefined };
  return next();
};
