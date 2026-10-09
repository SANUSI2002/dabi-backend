// What Sabi says on WhatsApp. Business-initiated messages must use Meta-approved templates
// (see docs/NOTIFICATIONS_WHATSAPP.md); replies inside the 24-hour window after a patient writes to
// us can be plain text. `preview` is the rendered text, used by the simulator and in tests.
import { whatsappConfig } from './whatsapp.provider.js';

/**
 * "+2348031234567" from what a patient types: international (+234…, 00234…), or a Nigerian local
 * number (0803…). Null when it cannot be a phone number.
 */
export function normalizePhone(input) {
  let digits = String(input ?? '').trim();
  const international = digits.startsWith('+') || digits.startsWith('00');
  digits = digits.replace(/[\s().-]/g, '').replace(/^\+/, '').replace(/^00/, '');
  if (!/^\d+$/.test(digits)) return null;
  if (!international && /^0\d{10}$/.test(digits)) digits = `234${digits.slice(1)}`;
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

/** "+234 *** *** 4567": enough for the patient to recognise their number. */
export const maskPhone = (phone) => (phone ? `${phone.slice(0, 4)} *** *** ${phone.slice(-4)}` : null);

// Quick-reply payloads name the reminder and the connection it was sent to, so a tap from a number
// that has since been replaced is refused.
export const ACTIONS = { TAKEN: 'TAKEN', SNOOZE: 'SNOOZE' };
export const buttonPayload = (action, jobId, connectionId) => `${action}:${jobId}:${connectionId}`;
export function parsePayload(payload) {
  const match = /^(TAKEN|SNOOZE):([0-9a-f-]{36}):([0-9a-f-]{36})$/i.exec(String(payload || ''));
  return match ? { action: match[1].toUpperCase(), jobId: match[2].toLowerCase(), connectionId: match[3].toLowerCase() } : null;
}

const body = (...values) => ({ type: 'body', parameters: values.map((text) => ({ type: 'text', text: String(text) })) });

export function verificationMessage(code) {
  const { templates } = whatsappConfig();
  return {
    name: templates.verification,
    // Authentication templates repeat the code in the copy-code button.
    components: [body(code), { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }],
    preview: `${code} is your Sabi verification code. For your security, do not share this code.`,
    buttons: [{ title: 'Copy code' }],
  };
}

/** `label` is the medicine name only when the patient chose to show it; otherwise "morning medicine". */
export function reminderMessage({ label, time, takenPayload, snoozePayload }) {
  const { templates } = whatsappConfig();
  const quickReply = (index, payload) => ({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload }] });
  return {
    name: templates.reminder,
    components: [body(label, time), quickReply(0, takenPayload), quickReply(1, snoozePayload)],
    preview: `It's time for your ${label} dose (${time}).`,
    buttons: [{ title: 'Taken', payload: takenPayload }, { title: 'Remind me later', payload: snoozePayload }],
  };
}

export function updateMessage(title) {
  const { templates } = whatsappConfig();
  return {
    name: templates.update,
    components: [body(title)],
    preview: `You have a new update in Sabi: ${title}. Open Sabi to view it.`,
  };
}

/** `what` is "video consultation" or "in-person appointment"; `when` is "tomorrow at 10:00 am". No doctor or reason. */
export function appointmentReminderMessage({ what, when }) {
  const { templates } = whatsappConfig();
  return {
    name: templates.appointment,
    components: [body(what, when)],
    preview: `Reminder: your ${what} is ${when}. Open Sabi to join or manage it.`,
  };
}

export const REPLIES = {
  recorded: (time) => `Recorded: dose taken at ${time}. Well done.`,
  alreadyRecorded: 'Already recorded. You do not need to do anything else.',
  snoozed: (time) => `OK. I'll remind you again at ${time}.`,
  snoozeLimit: 'This reminder has been snoozed the most times allowed. Open Sabi to record the dose when you take it.',
  doseClosed: 'This dose is no longer scheduled. Open Sabi to see your current medicines.',
  inactive: 'This button is no longer active. Open Sabi to manage your medicines and notifications.',
  help: 'Sabi sends medication reminders here. Use the buttons on a reminder, or open Sabi to manage your medicines and notifications.',
};
