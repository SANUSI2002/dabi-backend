// The central notification service. Modules call notify() with an event; it
//   1. saves the in-app notification (the bell) — always, and first;
//   2. queues a WhatsApp delivery when the patient has WhatsApp on and accepts that kind of update,
//      and a phone-notification delivery when they allowed notifications on a device.
// Sending happens later in the worker (notification.delivery.js), so a WhatsApp problem can never
// undo or delay the in-app notification. Pass the transaction client to commit both with the change
// that caused them.

// Kinds of update a patient can choose to receive on WhatsApp. The bell always gets everything.
export const WHATSAPP_CATEGORIES = ['MEDICATION', 'APPOINTMENT', 'CARE'];

export const EVENTS = {
  'medication.dose_due': { category: 'MEDICATION' },
  'prescription.issued': { category: 'CARE' },
  'care_plan.published': { category: 'CARE' },
  'visit_summary.ready': { category: 'CARE' },
  'prescription.cancelled': { category: 'CARE' },
  'care.accepted': { category: 'CARE' },
  'care.declined': { category: 'CARE' },
  'appointment.confirmed': { category: 'APPOINTMENT' },
  'appointment.declined': { category: 'APPOINTMENT' },
  'appointment.cancelled': { category: 'APPOINTMENT' },
  'appointment.reminder': { category: 'APPOINTMENT' },
  'account.notice': { category: 'ACCOUNT' },
};

export const wantsWhatsApp = (preference, category) => Boolean(preference?.whatsappEnabled && preference.whatsappCategories?.includes(category));
// Phone notifications cover every kind of update unless the patient narrowed them.
export const PUSH_CATEGORIES = ['MEDICATION', 'APPOINTMENT', 'CARE'];
export const wantsPush = (preference, category) => (preference?.pushCategories ?? PUSH_CATEGORIES).includes(category);

/**
 * Records one notification. `eventKey` makes it idempotent per person: the same key twice returns the
 * first notification and queues nothing new. `reminderJobId` links a medication reminder's delivery
 * to its reminder so the WhatsApp message and the phone notification can carry Taken / Remind me later.
 */
export async function notify(db, { userId, eventType, title, message, link = null, eventKey = null, reminderJobId = null }) {
  const event = EVENTS[eventType];
  if (!event) throw new Error(`Unknown notification event ${eventType}`);
  if (eventKey) {
    const existing = await db.notification.findFirst({ where: { userId, eventKey } });
    if (existing) return { notification: existing, created: false };
  }
  const notification = await db.notification.create({
    data: { userId, title: title.slice(0, 200), message: message.slice(0, 1000), category: event.category, eventType, eventKey, link },
  });
  const preference = await db.notificationPreference.findUnique({ where: { userId } });
  if (wantsWhatsApp(preference, event.category)) {
    await db.notificationDelivery.create({ data: { notificationId: notification.id, userId, channel: 'WHATSAPP', reminderJobId } });
  }
  // One phone-notification delivery covers every device the patient allowed.
  if (wantsPush(preference, event.category) && await db.pushSubscription.count({ where: { userId, revokedAt: null } })) {
    await db.notificationDelivery.create({ data: { notificationId: notification.id, userId, channel: 'PUSH', reminderJobId } });
  }
  return { notification, created: true };
}
