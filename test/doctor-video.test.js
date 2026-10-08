import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVideoService } from '../src/modules/doctor-video/doctor-video.service.js';
import { createDailyProvider, dailyConfigured } from '../src/modules/doctor-video/daily.provider.js';
const time = new Date('2026-10-05T18:00:00Z');
const name = 'sabi-v-' + 'a'.repeat(32);
const room = { appointmentId: 'appt', roomName: name, expiresAt: new Date('2026-10-05T18:45:00Z'), revokedAt: null };
const active = () => ({ accountStatus: 'ACTIVE', emailVerifiedAt: time });
const appointment = () => ({ id: 'appt', patientId: 'patient', status: 'CONFIRMED', consultationType: 'VIRTUAL', startsAt: time, endsAt: new Date('2026-10-05T18:30:00Z'), patient: active(), doctorProfile: { userId: 'doctor', professionType: 'DOCTOR', verificationStatus: 'VERIFIED', user: active() } });
const env = { DAILY_VIDEO_ENABLED: 'true', DAILY_PROCESSING_APPROVED: 'true', DAILY_API_KEY: 'synthetic-key', DAILY_DOMAIN: 'sabihealth' };
let db, provider, service;
beforeEach(() => {
  db = { doctorAppointment: { findFirst: vi.fn().mockResolvedValue(appointment()) }, userRole: { findFirst: vi.fn().mockResolvedValue({ id: 'role' }) }, doctorVideoRoom: { createMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn().mockResolvedValue(room), findMany: vi.fn().mockResolvedValue([room]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) }, activityLog: { create: vi.fn() }, auditEvent: { create: vi.fn(), findFirst: vi.fn() } };
  provider = { ensureRoom: vi.fn().mockResolvedValue({ url: `https://sabihealth.daily.co/${name}` }), token: vi.fn().mockResolvedValue('synthetic-token-for-tests'), revoke: vi.fn() };
  service = createVideoService({ db, provider, env, now: () => time });
});
describe('appointment-bound video access', () => {
  it.each(['doctor', 'patient'])('issues %s access only to its appointment; never audits tokens', async (role) => {
    const result = await service.join(role, 'appt', role, { providerConsent: true });
    expect(result.token).toBe('synthetic-token-for-tests');
    expect(db.doctorAppointment.findFirst.mock.calls[0][0].where).toEqual(role === 'doctor' ? { id: 'appt', doctorProfile: { userId: 'doctor' } } : { id: 'appt', patientId: 'patient' });
    expect(provider.token).toHaveBeenCalledWith(room, role);
    expect(JSON.stringify(db.activityLog.create.mock.calls)).not.toContain(result.token);
    expect(db.doctorAppointment.findFirst).toHaveBeenCalledTimes(3);
  });
  it('denies unknown appointments without provider calls', async () => {
    db.doctorAppointment.findFirst.mockResolvedValue(null);
    await expect(service.join('outsider', 'appt', 'patient', { providerConsent: true })).rejects.toMatchObject({ code: 'VIDEO_NOT_FOUND', status: 404 });
    expect(provider.ensureRoom).not.toHaveBeenCalled();
  });
  it.each(['REQUESTED', 'CANCELLED', 'COMPLETED', 'DECLINED'])('blocks %s appointments', async (status) => {
    db.doctorAppointment.findFirst.mockResolvedValue({ ...appointment(), status });
    await expect(service.join('patient', 'appt', 'patient', { providerConsent: true })).rejects.toMatchObject({ code: 'VIDEO_APPOINTMENT_NOT_READY' });
    expect(provider.token).not.toHaveBeenCalled();
  });
  it('denies unverified doctors, inactive patients and non-patient accounts', async () => {
    const a = appointment(); a.doctorProfile.verificationStatus = 'PENDING'; db.doctorAppointment.findFirst.mockResolvedValueOnce(a);
    await expect(service.check('doctor', 'appt', 'doctor')).rejects.toMatchObject({ code: 'VIDEO_ACCESS_DENIED' });
    const b = appointment(); b.patient.accountStatus = 'INACTIVE'; db.doctorAppointment.findFirst.mockResolvedValueOnce(b);
    await expect(service.check('patient', 'appt', 'patient')).rejects.toMatchObject({ code: 'VIDEO_ACCESS_DENIED' });
    db.userRole.findFirst.mockResolvedValue(null);
    await expect(service.check('patient', 'appt', 'patient')).rejects.toMatchObject({ code: 'VIDEO_ACCESS_DENIED' });
  });
  it('rejects in-person, too early, and expired appointments', async () => {
    db.doctorAppointment.findFirst.mockResolvedValueOnce({ ...appointment(), consultationType: 'IN_PERSON' });
    await expect(service.check('patient', 'appt', 'patient')).rejects.toMatchObject({ code: 'VIDEO_APPOINTMENT_NOT_READY' });
    const early = createVideoService({ db, provider, env, now: () => new Date(time.getTime() - 11 * 60000) });
    await expect(early.check('patient', 'appt', 'patient')).rejects.toMatchObject({ code: 'VIDEO_TOO_EARLY' });
    const late = createVideoService({ db, provider, env, now: () => room.expiresAt });
    await expect(late.check('patient', 'appt', 'patient')).rejects.toMatchObject({ code: 'VIDEO_WINDOW_ENDED' });
  });
  it('fails closed when disabled or consent is missing', async () => {
    expect(dailyConfigured({ ...env, DAILY_PROCESSING_APPROVED: 'false' })).toBe(false);
    await expect(service.join('doctor', 'appt', 'doctor', {})).rejects.toMatchObject({ code: 'VIDEO_CONSENT_REQUIRED' });
    expect(provider.token).not.toHaveBeenCalled();
  });
  it('rechecks cancellation during provider I/O before issuing access', async () => {
    db.doctorAppointment.findFirst.mockResolvedValueOnce(appointment()).mockResolvedValue({ ...appointment(), status: 'CANCELLED' });
    await expect(service.join('doctor', 'appt', 'doctor', { providerConsent: true })).rejects.toMatchObject({ code: 'VIDEO_APPOINTMENT_NOT_READY' });
    expect(provider.token).not.toHaveBeenCalled();
  });
  it('does not issue an already revoked room', async () => {
    db.doctorVideoRoom.findUnique.mockResolvedValue({ ...room, revokedAt: time });
    await expect(service.join('doctor', 'appt', 'doctor', { providerConsent: true })).rejects.toMatchObject({ code: 'VIDEO_WINDOW_ENDED' });
    expect(provider.ensureRoom).not.toHaveBeenCalled();
  });
  it('records which consent wording each side accepted, and refuses the other side\'s', async () => {
    const consentLogged = (version) => expect(db.activityLog.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'DOCTOR_VIDEO_JOIN_AUTHORIZED', meta: expect.objectContaining({ consentVersion: version }) }) }));
    await service.join('patient', 'appt', 'patient', { providerConsent: true, consentVersion: 'telemedicine-patient-v1' });
    consentLogged('telemedicine-patient-v1');
    await service.join('doctor', 'appt', 'doctor', { providerConsent: true, consentVersion: 'telemedicine-professional-v1' });
    consentLogged('telemedicine-professional-v1');
    await expect(service.join('patient', 'appt', 'patient', { providerConsent: true, consentVersion: 'telemedicine-professional-v1' })).rejects.toMatchObject({ code: 'VIDEO_CONSENT_REQUIRED', status: 400 });
    // Clients from before the versioned notice still consent; their join is logged as the original notice.
    await service.join('patient', 'appt', 'patient', { providerConsent: true });
    consentLogged('daily-video-v1');
  });
  it('reuses an existing room without inserting another', async () => {
    await service.join('patient', 'appt', 'patient', { providerConsent: true });
    expect(db.doctorVideoRoom.createMany).not.toHaveBeenCalled();
  });
  it('lets simultaneous first joiners share the one room that wins the insert race', async () => {
    // Both callers see no room, both insert with ON CONFLICT DO NOTHING, and both read back the winner.
    const winner = { ...room, roomName: 'sabi-v-' + 'b'.repeat(32) };
    db.doctorVideoRoom.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(winner);
    const [doctor, patient] = await Promise.all([service.join('doctor', 'appt', 'doctor', { providerConsent: true }), service.join('patient', 'appt', 'patient', { providerConsent: true })]);
    expect(doctor.token).toBeTruthy(); expect(patient.token).toBeTruthy();
    expect(db.doctorVideoRoom.createMany).toHaveBeenCalledTimes(2);
    expect(db.doctorVideoRoom.createMany.mock.calls.every(([args]) => args.skipDuplicates === true && args.data[0].appointmentId === 'appt')).toBe(true);
    expect(provider.ensureRoom.mock.calls.map(([r]) => r.roomName)).toEqual([winner.roomName, winner.roomName]);
  });
  it('persists cleanup completion, or backs off a provider outage', async () => {
    await service.cleanup(); expect(provider.revoke).toHaveBeenCalledWith(room);
    expect(db.doctorVideoRoom.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { revokedAt: time } }));
    provider.revoke.mockRejectedValue(new Error('offline')); await service.cleanup();
    expect(db.doctorVideoRoom.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: { cleanupAfter: new Date(time.getTime() + 60000) } }));
  });
});
describe('Daily provider controls', () => {
  const safeRoom = () => ({ name, privacy: 'private', url: `https://sabihealth.daily.co/${name}`, config: { exp: Math.floor(room.expiresAt / 1000), eject_at_room_exp: true, max_participants: 2, enable_chat: true, enable_knocking: false, permissions: { canAdmin: false } } });
  const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
  it('creates a private two-person room with no recording or PHI', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({}, 404)).mockResolvedValueOnce(response(safeRoom()));
    await createDailyProvider({ env, fetcher }).ensureRoom(room, time);
    const body = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(body.properties).toMatchObject({ max_participants: 2, enable_chat: true, enable_knocking: false, enable_recording: false, enable_transcription_storage: false, permissions: { canAdmin: false } });
    expect(body.privacy).toBe('private'); expect(body.name).toBe(name);
  });
  it.each(['public', 'wrong-url', 'recording', 'owner', 'unbounded'])('rejects unsafe %s room settings', async (kind) => {
    const r = safeRoom(); if (kind === 'public') r.privacy = 'public'; if (kind === 'wrong-url') r.url = 'https://evil.test/call'; if (kind === 'recording') r.config.enable_recording = 'cloud'; if (kind === 'owner') r.config.permissions.canAdmin = true; if (kind === 'unbounded') delete r.config.exp;
    const fetcher = vi.fn().mockResolvedValue(response(r));
    await expect(createDailyProvider({ env, fetcher }).ensureRoom(room, time)).rejects.toMatchObject({ code: 'VIDEO_ROOM_UNSAFE' });
  });
  it('room-scopes tokens and leaves both users non-owners with fixed opaque IDs', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ token: 'synthetic-token-for-tests' }));
    await createDailyProvider({ env, fetcher }).token(room, 'patient');
    expect(JSON.parse(fetcher.mock.calls[0][1].body).properties).toMatchObject({ room_name: name, user_id: `${name}-patient`, user_name: 'Patient', is_owner: false, eject_at_token_exp: true, permissions: { canAdmin: false } });
  });
  it('handles quota errors without provider message or key disclosure', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ secret: 'do-not-leak' }, 429));
    await expect(createDailyProvider({ env, fetcher }).token(room, 'doctor')).rejects.toMatchObject({ code: 'VIDEO_PROVIDER_LIMIT', status: 503 });
  });
  it('revokes access, ejects both users and deletes the room in order', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({}));
    await createDailyProvider({ env, fetcher }).revoke(room);
    expect(fetcher.mock.calls.map(([url, opts]) => [url.split('/').at(-1), opts.method])).toEqual([[name, 'POST'], ['eject', 'POST'], [name, 'DELETE']]);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ user_ids: [`${name}-doctor`, `${name}-patient`], ban: true });
  });
  it('still deletes an expired room when the inactive session rejects ejection', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({}, 400)).mockResolvedValueOnce(response({}));
    await expect(createDailyProvider({ env, fetcher }).revoke(room)).resolves.toBeUndefined();
    expect(fetcher.mock.calls.at(-1)[1].method).toBe('DELETE');
  });
});
