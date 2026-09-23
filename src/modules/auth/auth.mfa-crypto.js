import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const base32Encode = (bytes) => {
  let bits = 0; let value = 0; let result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { result += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
};

export const base32Decode = (encoded) => {
  let bits = 0; let value = 0; const result = [];
  for (const char of encoded.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Invalid authenticator secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) { result.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(result);
};

export const totpAt = (secret, unixSeconds, digits = 6) => {
  const step = Math.floor(unixSeconds / 30);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits);
  return String(value).padStart(digits, '0');
};

export const matchingTotpStep = (secret, code, unixSeconds = Math.floor(Date.now() / 1000)) => {
  if (!/^\d{6}$/.test(code)) return null;
  const baseStep = Math.floor(unixSeconds / 30);
  for (const offset of [-1, 0, 1]) {
    const step = baseStep + offset;
    if (step < 0) continue;
    const expected = Buffer.from(totpAt(secret, step * 30));
    if (crypto.timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
};

const encryptionKey = () => {
  const value = process.env.MFA_ENCRYPTION_KEY;
  const key = value ? Buffer.from(value, 'base64') : null;
  if (!key || key.length !== 32) throw Object.assign(new Error('MFA encryption key is not configured'), { code: 'MFA_UNAVAILABLE' });
  return key;
};

export const encryptSecret = (secret) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
};

export const decryptSecret = (encoded) => {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 29) throw new Error('Invalid encrypted authenticator secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
};
