import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { scanWithCloudmersive } from '../src/modules/platform/platform.cloudmersive.js';

// Explicit operator-run probe for the disposable Sabi test database only.
// Never uses stored documents, user records, storage URLs or real credentials.
const allowedDatabase = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/sabi_backend_test_db'; }
  catch { return false; }
})();
if (!allowedDatabase || process.env.EVIDENCE_SCANNER_PROVIDER !== 'cloudmersive') {
  console.error('[scanner-probe] TEST_CONFIGURATION_REQUIRED');
  process.exit(1);
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
const rows = Buffer.alloc(64 * 193, 255);
for (let y = 0; y < 64; y++) rows[y * 193] = 0;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
  chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
try {
  const clean = await scanWithCloudmersive(png, { contentType: 'image/png' });
  if (clean.verdict !== 'CLEAN') throw new Error('CLEAN_FIXTURE_FAILED');
  console.log('[scanner-probe] SYNTHETIC_PNG_CLEAN_PASS');
  // Stay below the free key's one-call-per-second rate limit.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const invalid = await scanWithCloudmersive(Buffer.from('Synthetic invalid PNG. No malware or personal data.'), { contentType: 'image/png' });
  if (invalid.verdict !== 'REJECTED') throw new Error('INVALID_FIXTURE_FAILED');
  console.log('[scanner-probe] DISGUISED_INVALID_FILE_BLOCKED_PASS');
  console.log('[scanner-probe] PASSED_2_OF_2');
} catch (error) {
  const safe = /^(CLOUDMERSIVE_[A-Z_]+|CLEAN_FIXTURE_FAILED|INVALID_FIXTURE_FAILED)$/.test(error.message) ? error.message : 'PROBE_FAILED';
  console.error('[scanner-probe] ' + safe);
  process.exit(1);
}
