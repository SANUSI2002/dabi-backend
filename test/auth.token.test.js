import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { generateAccessToken, generateRefreshToken } from '../src/modules/auth/auth.token.js';
import { passwordResetConfirmSchema } from '../src/modules/auth/auth.validator.js';

process.env.JWT_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

describe('auth token utilities', () => {
  it('creates separate access and refresh token payloads', () => {
    const user = { id: 'user-1', email: 'patient@example.test' };
    expect(jwt.verify(generateAccessToken(user), process.env.JWT_SECRET)).toMatchObject({ userId: user.id, email: user.email });
    expect(jwt.verify(generateRefreshToken(user), process.env.JWT_REFRESH_SECRET)).toMatchObject({ userId: user.id });
  });
});

describe('password reset validation', () => {
  const base = { uid: '5f95ea6b-15e7-4b29-85be-8189931bf2d6', token: 'a'.repeat(64), password: 'StrongPass1!', confirmPassword: 'StrongPass1!' };
  it('requires a strong matching password', () => {
    expect(passwordResetConfirmSchema.safeParse({ body: base }).success).toBe(true);
    expect(passwordResetConfirmSchema.safeParse({ body: { ...base, password: 'weakpass', confirmPassword: 'weakpass' } }).success).toBe(false);
    expect(passwordResetConfirmSchema.safeParse({ body: { ...base, confirmPassword: 'different' } }).success).toBe(false);
  });
});
