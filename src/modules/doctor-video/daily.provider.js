const API = 'https://api.daily.co/v1';
export const videoError = (code, status = 503) => Object.assign(new Error(code), { code, status });
export function dailyConfigured(env = process.env) {
  return env.DAILY_VIDEO_ENABLED === 'true' && env.DAILY_PROCESSING_APPROVED === 'true'
    && Boolean(env.DAILY_API_KEY) && /^[a-z0-9][a-z0-9-]{0,62}$/.test(env.DAILY_DOMAIN || '');
}
export function createDailyProvider({ env = process.env, fetcher = globalThis.fetch } = {}) {
  async function request(path, method = 'GET', body) {
    if (!env.DAILY_API_KEY) throw videoError('VIDEO_UNAVAILABLE');
    let response;
    try {
      response = await fetcher(`${API}${path}`, { method, redirect: 'error',
        headers: { Authorization: `Bearer ${env.DAILY_API_KEY}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: globalThis.AbortSignal.timeout(10000) });
    } catch { throw videoError('VIDEO_PROVIDER_UNAVAILABLE'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(videoError(response.status === 429 ? 'VIDEO_PROVIDER_LIMIT' : 'VIDEO_PROVIDER_UNAVAILABLE', response.status === 404 ? 404 : 503), { providerStatus: response.status, providerOperation: method === 'DELETE' ? 'DELETE_ROOM' : path.endsWith('/eject') ? 'EJECT' : path === '/rooms' ? 'CREATE_ROOM' : path === '/meeting-tokens' ? 'TOKEN' : method === 'POST' ? 'UPDATE_ROOM' : 'LOOKUP_ROOM' });
    return data;
  }
  const pathFor = (name) => {
    if (!/^sabi-v-[a-f0-9]{32}$/.test(name)) throw videoError('VIDEO_ROOM_INVALID');
    return `/rooms/${name}`;
  };
  function assertRoom(room, row) {
    const cfg = room.config || {};
    if (room.name !== row.roomName || room.privacy !== 'private'
      || room.url !== `https://${env.DAILY_DOMAIN}.daily.co/${row.roomName}`
      || cfg.exp !== Math.floor(new Date(row.expiresAt).getTime() / 1000)
      || cfg.eject_at_room_exp !== true || cfg.max_participants !== 2
      || cfg.enable_chat !== true || cfg.enable_knocking !== false
      || cfg.enable_recording || cfg.enable_transcription_storage || cfg.enable_advanced_chat
      || cfg.permissions?.canAdmin !== false) throw videoError('VIDEO_ROOM_UNSAFE');
    return room;
  }
  return {
    ensureRoom: async (row, startsAt) => {
      const path = pathFor(row.roomName);
      let room;
      try { room = await request(path); }
      catch (error) {
        if (error.status !== 404) throw error;
        try { room = await request('/rooms', 'POST', { name: row.roomName, privacy: 'private', properties: {
          nbf: Math.floor((new Date(startsAt).getTime() - 10 * 60000) / 1000), exp: Math.floor(new Date(row.expiresAt).getTime() / 1000),
          eject_at_room_exp: true, max_participants: 2, enforce_unique_user_ids: true,
          enable_prejoin_ui: true, enable_knocking: false, enable_chat: true, enable_shared_chat_history: false,
          enable_advanced_chat: false, enable_screenshare: false, enable_recording: false,
          enable_live_captions_ui: false, enable_transcription_storage: false,
          permissions: { canAdmin: false },
        } }); }
        catch (creationError) {
          // A second participant may have created the same named room concurrently.
          if (creationError.code === 'VIDEO_PROVIDER_LIMIT') throw creationError;
          try { room = await request(path); }
          catch (lookupError) { if (lookupError.status === 404) throw creationError; throw lookupError; }
        }
      }
      return assertRoom(room, row);
    },
    token: async (row, role) => {
      const result = await request('/meeting-tokens', 'POST', { properties: {
        room_name: row.roomName, user_id: `${row.roomName}-${role}`, user_name: role === 'doctor' ? 'Doctor' : 'Patient',
        is_owner: false, exp: Math.floor(new Date(row.expiresAt).getTime() / 1000), eject_at_token_exp: true,
        enable_screenshare: false, enable_recording: false, enable_recording_ui: false,
        enable_live_captions_ui: false, start_cloud_recording: false, auto_start_transcription: false,
        permissions: { canAdmin: false },
      } });
      if (typeof result.token !== 'string' || result.token.length < 20 || result.token.length > 8192) throw videoError('VIDEO_PROVIDER_UNAVAILABLE');
      return result.token;
    },
    revoke: async (row) => {
      const path = pathFor(row.roomName);
      try {
        // Daily rejects an expiry already in the past by the time it receives it.
        // Use a short future fallback, then immediately ban/eject and delete.
        await request(path, 'POST', { properties: { exp: Math.floor(Date.now() / 1000) + 15, eject_at_room_exp: true } });
        // Expiry with forced ejection is the primary stop. An empty session may
        // reject explicit ejection; deletion still invalidates further room access.
        try {
          await request(`${path}/eject`, 'POST', { user_ids: [`${row.roomName}-doctor`, `${row.roomName}-patient`], ban: true });
        } catch { /* The room is already expired; delete it even without a session. */ }
        await request(path, 'DELETE');
      } catch (error) { if (error.status !== 404) throw error; }
    },
  };
}
