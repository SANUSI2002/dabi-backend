import { createHmac } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizePhone, parsePayload, buttonPayload, reminderMessage, maskPhone } from '../src/modules/whatsapp/whatsapp.messages.js';
import { whatsappProvider } from '../src/modules/whatsapp/whatsapp.provider.js';
import { signatureValid } from '../src/modules/whatsapp/whatsapp.webhook.js';
import { courseEndDay, localClock, localDay, suggestedTimes, zonedInstant } from '../src/modules/medication-schedules/schedule.time.js';

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; vi.restoreAllMocks(); });

describe('phone numbers', () => {
  it('accepts Nigerian local and international formats', () => {
    expect(normalizePhone('0803 123 4567')).toBe('+2348031234567');
    expect(normalizePhone('+234 (803) 123-4567')).toBe('+2348031234567');
    expect(normalizePhone('002348031234567')).toBe('+2348031234567');
    expect(normalizePhone('+44 7700 900123')).toBe('+447700900123');
    expect(normalizePhone('call me')).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
    expect(maskPhone('+2348031234567')).toBe('+234 *** *** 4567');
  });
});

describe('button payloads', () => {
  const job = '0f95ea6b-15e7-4b29-85be-8189931bf2d6';
  const connection = '1f95ea6b-15e7-4b29-85be-8189931bf2d6';
  it('round-trip and reject anything else', () => {
    expect(parsePayload(buttonPayload('TAKEN', job, connection))).toEqual({ action: 'TAKEN', jobId: job, connectionId: connection });
    expect(parsePayload(`DELETE:${job}:${connection}`)).toBeNull();
    expect(parsePayload('TAKEN')).toBeNull();
  });
  it('fit inside the WhatsApp quick-reply limit', () => {
    const message = reminderMessage({ label: 'morning medicine', time: '8:00 am', takenPayload: buttonPayload('TAKEN', job, connection), snoozePayload: buttonPayload('SNOOZE', job, connection) });
    for (const component of message.components.filter((c) => c.sub_type === 'quick_reply')) expect(component.parameters[0].payload.length).toBeLessThanOrEqual(256);
  });
});

describe('time zones', () => {
  it('turns Lagos clock times into the right instants', () => {
    expect(zonedInstant('2026-10-08', '08:00', 'Africa/Lagos').toISOString()).toBe('2026-10-08T07:00:00.000Z');
    expect(localDay(new Date('2026-10-08T23:30:00Z'), 'Africa/Lagos')).toBe('2026-10-09');
    expect(localClock(new Date('2026-10-08T23:30:00Z'), 'Africa/Lagos')).toBe('00:30');
  });
  it('handles a daylight-saving change', () => {
    // London moves from BST (UTC+1) to GMT on 2026-10-25.
    expect(zonedInstant('2026-10-24', '08:00', 'Europe/London').toISOString()).toBe('2026-10-24T07:00:00.000Z');
    expect(zonedInstant('2026-10-26', '08:00', 'Europe/London').toISOString()).toBe('2026-10-26T08:00:00.000Z');
  });
  it('suggests times and course length from a prescription', () => {
    expect(suggestedTimes('THREE_TIMES_DAILY')).toEqual(['08:00', '14:00', '20:00']);
    expect(suggestedTimes('AS_NEEDED')).toEqual([]);
    expect(courseEndDay('2026-10-08', '7 days')).toBe('2026-10-14');
    expect(courseEndDay('2026-10-08', '2 weeks')).toBe('2026-10-21');
    expect(courseEndDay('2026-10-08', 'until finished')).toBeNull();
  });
});

describe('Cloud API provider', () => {
  const configure = () => Object.assign(process.env, { WHATSAPP_PROVIDER: 'cloud', WHATSAPP_ACCESS_TOKEN: 'synthetic-token', WHATSAPP_PHONE_NUMBER_ID: '123456', WHATSAPP_API_VERSION: 'v21.0' });

  it('is off until both credentials are set', () => {
    process.env.WHATSAPP_PROVIDER = 'cloud';
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    expect(whatsappProvider()).toBeNull();
    configure();
    expect(whatsappProvider().name).toBe('cloud');
  });

  it('sends a template to the number without the plus sign', async () => {
    configure();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), { status: 200 }));
    const result = await whatsappProvider().sendTemplate('+2348031234567', { name: 'sabi_update', components: [] });
    expect(result).toEqual({ messageId: 'wamid.X' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v21.0/123456/messages');
    expect(init.headers.Authorization).toBe('Bearer synthetic-token');
    expect(JSON.parse(init.body)).toMatchObject({ messaging_product: 'whatsapp', to: '2348031234567', type: 'template', template: { name: 'sabi_update', language: { code: 'en' } } });
  });

  it('retries rate limits and server errors but not a number that is not on WhatsApp', async () => {
    configure();
    const reply = (status, code) => new Response(JSON.stringify({ error: { code } }), { status });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(429, 130429)).mockResolvedValueOnce(reply(500, 1)).mockResolvedValueOnce(reply(400, 131026));
    const provider = whatsappProvider();
    await expect(provider.sendText('+2348031234567', 'x')).rejects.toMatchObject({ transient: true });
    await expect(provider.sendText('+2348031234567', 'x')).rejects.toMatchObject({ transient: true });
    await expect(provider.sendText('+2348031234567', 'x')).rejects.toMatchObject({ transient: false, code: 131026 });
  });
});

describe('webhook signatures', () => {
  it('match only the exact body and secret', () => {
    const body = Buffer.from('{"entry":[]}');
    const header = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`;
    expect(signatureValid(body, header, 'secret')).toBe(true);
    expect(signatureValid(Buffer.from('{"entry":[1]}'), header, 'secret')).toBe(false);
    expect(signatureValid(body, header, 'other')).toBe(false);
    expect(signatureValid(body, header, '')).toBe(false);
    expect(signatureValid(body, 'sha1=abc', 'secret')).toBe(false);
  });
});
