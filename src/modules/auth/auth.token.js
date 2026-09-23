import jwt from 'jsonwebtoken';

export const generateAccessToken = (user, context = {}) => jwt.sign(
  { userId: user.id, email: user.email, tokenUse: 'access', ...(context.sessionId ? { sid: context.sessionId } : {}), ...(context.organizationId ? { organizationId: context.organizationId } : {}) },
  process.env.JWT_SECRET,
  { expiresIn: process.env.ACCESS_TOKEN_EXPIRY || '15m', issuer: process.env.JWT_ISSUER || 'sabi-identity', audience: process.env.JWT_AUDIENCE || 'sabi-api' },
);

export const generateRefreshToken = (user) => jwt.sign(
  { userId: user.id },
  process.env.JWT_REFRESH_SECRET,
  { expiresIn: process.env.REFRESH_TOKEN_EXPIRY || '30d' },
);

export const getRefreshTokenExpiresAt = (token) => {
  const decoded = jwt.decode(token);
  if (typeof decoded?.exp !== 'number') throw new Error('Refresh token is missing an expiry');
  return new Date(decoded.exp * 1000);
};
