// AES-256-GCM for secrets the EMR must store but never show again (webhook signing secrets).
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const key = () => {
  const configured = process.env.EMR_SECRET_KEY;
  if (configured) {
    const bytes = Buffer.from(configured, 'base64');
    if (bytes.length !== 32) throw new Error('EMR_SECRET_KEY must be 32 bytes, base64-encoded');
    return bytes;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('EMR_SECRET_KEY is required in production');
  return createHash('sha256').update('sabi-emr-development-only-secret-key').digest();
};

export const encryptSecret = (plaintext) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
};

export const decryptSecret = (ciphertext) => {
  const [version, iv, tag, body] = ciphertext.split('.');
  if (version !== 'v1') throw new Error('Unsupported secret format');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
};

export const newWebhookSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;
