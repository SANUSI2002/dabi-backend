// Provider protocol smoke check only: opaque synthetic room, no people/media/PHI.
import 'dotenv/config';
import crypto from 'node:crypto';
import console from 'node:console';
import process from 'node:process';
import { createDailyProvider } from '../src/modules/doctor-video/daily.provider.js';
const provider = createDailyProvider();
const row = { roomName: `sabi-v-${crypto.randomBytes(16).toString('hex')}`, expiresAt: new Date(Date.now() + 5 * 60000) };
let passed = false;
try {
  await provider.ensureRoom(row, new Date());
  await provider.token(row, 'doctor');
  await provider.token(row, 'patient');
  console.log('[video-preflight] private room and two restricted tokens verified; no participants joined');
  passed = true;
} catch (error) { console.error(`[video-preflight] failed: ${error.code || 'UNKNOWN'}${Number.isInteger(error.providerStatus) ? ` (provider HTTP ${error.providerStatus})` : ''}`); }
finally { try { await provider.revoke(row); console.log('[video-preflight] synthetic room cleanup verified'); } catch (error) { console.error(`[video-preflight] synthetic room cleanup failed (${error.code || 'UNKNOWN'} ${error.providerOperation || 'UNKNOWN'}${Number.isInteger(error.providerStatus) ? ` HTTP ${error.providerStatus}` : ''}); room expires automatically`); passed = false; } }
// Optional startup diagnostic must never prevent the API starting after a failed probe.
if (!passed && !process.argv.includes('--startup')) process.exitCode = 1;
