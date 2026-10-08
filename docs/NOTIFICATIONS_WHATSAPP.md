# Notifications, WhatsApp and medication reminders

One notification service for every Sabi module, with in-app delivery always on and WhatsApp as an
opt-in channel. The first milestone is the full loop:

> enable WhatsApp → receive a medication reminder → tap **Taken** → the same dose shows as taken in Sabi.

The AI agent, web push and the remaining notification categories build on the same records later.

## Decisions

| Topic | Decision |
|---|---|
| Channel | Official WhatsApp **Cloud API**, one Sabi business number. |
| Number verification | Sabi sends a 6-digit code with an approved **authentication template**; the patient enters it in Sabi. |
| Medicines with reminders | Doctor-issued prescriptions (times proposed from the frequency, editable) and medicines patients add themselves. "As needed" is never scheduled. |
| Scheduler | Runs inside the always-on API process with a database-backed queue (`FOR UPDATE SKIP LOCKED`), so jobs survive restarts and several instances never double-send. |
| Sensitive content | WhatsApp shows medicine names only if the patient turns on **Show medication details**; otherwise "your morning medicine". Other categories announce an update and link to Sabi. |

## Records

| Table | Purpose |
|---|---|
| `notification_preferences` | Per patient: WhatsApp on/off, accepted categories, medication-details choice, timezone, consent version and time. |
| `whatsapp_connections` | Patient ↔ number, `PENDING` (code sent) → `ACTIVE` → `REVOKED`; hashed code, attempts, expiry. One active connection per patient and per number. |
| `notifications` (extended) | Bell items: category, event type, idempotency key, in-app link. |
| `notification_deliveries` | One row per channel attempt: status `PENDING → SENT → DELIVERED → READ` or `FAILED/SKIPPED/CANCELLED`, provider message id, attempts, the connection it was sent to. |
| `medication_schedules` | Source (prescription item or patient medicine), times, timezone, start/end, status, **version**. |
| `medication_doses` | One row per scheduled dose; patient-reported status `NOT_CONFIRMED / TAKEN / SKIPPED / CANCELLED`; confirmed via app or WhatsApp. |
| `reminder_jobs` | The durable queue: due time, snoozes, `SCHEDULED / SNOOZED / SENT / EXPIRED / CANCELLED / FAILED`. |
| `whatsapp_webhook_events` | Provider event ids already processed, so a repeated webhook never applies twice. |
| `audit_events` | Enabling, number changes, disabling, dose confirmations and snoozes, with the channel. |

Delivery status (sent/delivered/read) is never used as adherence. A patient not answering does not
mean a missed dose.

## Flows

**Enable** (Settings → Notifications → WhatsApp): the patient confirms the number (registered number
pre-filled) → Sabi sends the code → patient enters it → connection `ACTIVE`, preferences saved with
consent version and time, audit entry written.

**Change number**: a new `PENDING` connection is verified while the old one stays active; on success
the new one activates and the old one is revoked in the same transaction. Old-number messages and old
buttons are rejected because every button carries the connection version it was sent to.

**Event → notification**: modules call `notify()` with an event type and an idempotency key. The
notification is saved first; deliveries are queued for each enabled channel. A WhatsApp failure never
removes or delays the in-app notification.

**Reminders**: the worker keeps 48 hours of doses ahead for each active schedule and a reminder job per
dose. When a job is due it re-checks the dose (still unconfirmed, schedule active, same version) and
the age (reminders older than 2 hours are expired, not sent). Deliveries re-check opt-out, category and
the active connection just before sending.

**Taken / Remind me later**: the button payload names the reminder job and connection version. The
webhook verifies the signature, ignores repeated event ids, checks the sender's number matches the
active connection, then records the dose (a second tap answers "Already recorded") or snoozes the
reminder 30 minutes (up to 3 times). Snoozing never moves the prescribed schedule. Changing or
discontinuing a schedule bumps its version and cancels future doses and jobs.

## Meta setup (owner's checklist)

1. Meta Business portfolio (verified business) and a WhatsApp Business Account.
2. A dedicated Sabi phone number registered on the Cloud API (not used in the WhatsApp app).
3. A Meta developer app with the WhatsApp product; a **System User** token with
   `whatsapp_business_messaging` and `whatsapp_business_management`.
4. Webhook: callback `https://<api>/api/v1/whatsapp/webhook`, verify token = `WHATSAPP_VERIFY_TOKEN`,
   subscribe to `messages`.
5. Templates (names are configurable):
   - `sabi_verification_code` — **Authentication**, copy-code button.
   - `sabi_medication_reminder` — **Utility**, body "It's time for your {{1}} dose ({{2}}).", quick replies
     **Taken** and **Remind me later**.
   - `sabi_update` — **Utility**, body "You have a new update in Sabi: {{1}}. Open Sabi to view it."
6. Payment method on the WhatsApp Business Account (template conversations are charged).

## Environment

| Variable | Purpose |
|---|---|
| `WHATSAPP_PROVIDER` | `cloud` (production) or `simulator` (local and tests). Unset = WhatsApp disabled. |
| `WHATSAPP_ACCESS_TOKEN` | System User token. Never logged. |
| `WHATSAPP_PHONE_NUMBER_ID` | The Sabi number's id. |
| `WHATSAPP_APP_SECRET` | Verifies `X-Hub-Signature-256` on webhooks. |
| `WHATSAPP_VERIFY_TOKEN` | Webhook subscription handshake. |
| `WHATSAPP_API_VERSION` | Graph API version, e.g. `v21.0`. |
| `WHATSAPP_TEMPLATE_LANGUAGE` | Template language code, default `en`. |
| `WHATSAPP_TEMPLATE_VERIFICATION` / `_REMINDER` / `_UPDATE` | Template names if different from the defaults. |
| `NOTIFICATION_WORKER` | `true` to run the scheduler in this process (on by default in production). |
