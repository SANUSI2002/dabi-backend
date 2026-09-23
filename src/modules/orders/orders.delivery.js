import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';

const encryptionKey = () => {
  const configured = process.env.ORDER_DELIVERY_ENCRYPTION_KEY;
  if (!configured) return null;
  const key = Buffer.from(configured, 'base64');
  return key.length === 32 ? key : null;
};

export const encryptDeliveryDetails = (details) => {
  const key = encryptionKey();
  if (!key) throw Object.assign(new Error('DELIVERY_ENCRYPTION_REQUIRED'), { code: 'DELIVERY_ENCRYPTION_REQUIRED' });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(details), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
};

// Call only after checking the assignment owner and current partner activation.
export const decryptDeliveryDetails = (encrypted) => {
  const key = encryptionKey();
  if (!key) throw new Error('Delivery encryption unavailable');
  const [version, iv, tag, ciphertext, extra] = (encrypted ?? '').split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext || extra !== undefined) {
    throw new Error('Invalid delivery ciphertext');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const details = JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final(),
  ]).toString('utf8'));
  return { recipientName: details.recipientName, recipientPhone: details.recipientPhone, address: details.address };
};
