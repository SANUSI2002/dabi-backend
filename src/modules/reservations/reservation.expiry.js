import { release } from './reservation.service.js';
import { due } from './reservation.repository.js';
let timer;
export const runExpiry = async () => { if (process.env.SKIP_DB_CONNECT === 'true') return 0; try { const items = await due(); await Promise.all(items.map(({ id, patientId }) => release(patientId, id))); return items.length; } catch { return 0; } };
export const startExpiryRunner = ({ intervalMs = 60000 } = {}) => { if (process.env.SKIP_DB_CONNECT === 'true' || timer) return; void runExpiry(); timer = globalThis.setInterval(() => { void runExpiry(); }, intervalMs); timer.unref?.(); };
export const stopExpiryRunner = () => { if (timer) globalThis.clearInterval(timer); timer = undefined; };
