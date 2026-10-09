# Sabi Emergency Card

## Flow and existing sources

The patient manages the card in the patient portal's Notification Settings, or opens the same component from their dashboard. Name/code/QR are identifiers only. The QR uses the application's current origin and configured build base, with the code in a fragment rather than a query string. The responder signs in with their own Sabi Identity session (including the existing MFA requirements), enters the code, and retrieves a read-only summary. No separate medical database is introduced.

Source data is the existing User/UserProfile and active or paused dated MedicationSchedule records. Linked instructions are included only for this patient's ISSUED prescription items. An old prescription alone is not evidence of a current medication. Free-text profile facts remain patient-reported, not clinician-verified. Missing allergies remain unknown; only an explicit recorded NKA is shown as such. Blood group always carries a clinical testing warning. No insurance, billing, consultation notes or entire records are exposed.

## Authorization

- Patient account must be ACTIVE with PATIENT role and sharing consent enabled for the selected scope.
- Care Circle requires this specific patient's ACTIVE, non-revoked relationship, current EMERGENCY_SUMMARY permission, an explicit owner grant timestamp and an unexpired accessExpiresAt if set.
- The historical expiresAt is an **invitation** deadline, not an active membership expiry. It is preserved untouched. accessExpiresAt is the separate optional membership deadline.
- Older UI versions automatically appended EMERGENCY_SUMMARY. Those stored permissions are preserved, but their new explicit-grant timestamp stays null. Owners must explicitly turn on Emergency Summary for those members. New owner invitations, owner approval and owner permission updates record this stamp. A join request cannot grant itself access.
- Hospital access requires an ACTIVE staff membership and account at an approved, set-up VERIFIED HOSPITAL, a DOCTOR or NURSE role with emergency.summary.read, and a VERIFIED matching professional qualification. Hospital administrators/reception/finance/pharmacy alone are ineligible. Patient enrollment at that hospital is not required. A reason of 5–300 characters is required.
- All checks repeat on every retrieval. Revoking membership/permission, suspending staff/hospital/patient, changing scope, disabling sharing or replacing the code blocks subsequent requests. Already viewed data or offline downloaded cards cannot be remotely erased.

## API

All routes are under `/api/v1/profile/emergency-card`, authenticated using existing Sabi Identity Bearer access tokens:

| Method | Path | Behaviour |
| --- | --- | --- |
| GET | `/` | Own patient identifier/settings; lazily creates a 96-bit cryptographic random code without opting in |
| PUT | `/` | Version, chosen name, sharingEnabled, scopes, notificationEnabled; enabling/changing active scope requires consentVersion `emergency-card-v1` |
| POST | `/replace-code` | Version and confirmation `REPLACE`; atomically rotates code/version |
| GET | `/responder` | Own eligible hospital choices, no patient data |
| POST | `/lookup` | Code; optional hospitalId plus reason. Generic 403 for unknown or unauthorized codes |

Safe additive migration `20261015110000_emergency_card` extends UserProfile, NotificationPreference, CareRelationship and the existing append-only AuditEvent. All existing users default to sharing OFF and notification OFF. No health records are copied. Only DOCTOR/NURSE access roles get the new hospital permission.

## Audit, notifications and caching

Success records actor, patient reference, relationship or hospital/membership, outcome, time, reason and code version. Denied records do not expose a discovered patient. Raw codes and clinical facts are not logged in ordinary logs or included in audits. Successful access calls the existing notify() service inside the transaction: in-app notice immediately, configured eligible external channels queued for the existing worker. Retrieval never waits on email/WhatsApp/push providers. The access notice includes the reader and time, never the summary.

Lookup rate limits are 12/account/minute and 100/IP/15 minutes, in addition to the application's global/auth limits. The current shared limiter is process-local: **one API instance only**; counters reset on restart. Before horizontally scaling, move the shared limiter to a distributed store. The codes' 96-bit entropy and generic denied responses protect against guessing/enumeration.

Responses use private/no-store, Pragma no-cache and no-referrer. The existing Workbox rules cache only the app shell and immutable assets, never API responses or other origins. The responder holds summaries only in memory and clears them on code/mode changes, sign-out, page hide and tab hiding. QR codes never contain health information or an authentication token.

## Phone behaviour and configuration

No new provider secret is required. The patient PWA reuses its installed service worker (push-sw.js). HTTPS, an active service worker, browser notification support and user-granted permission are required to show the local Emergency Card notification. Existing remote Web Push configuration is separate, not required to display this card.

Permission is requested only by a user action. Stable tag `sabi-emergency-card`, renotify false and best-effort requireInteraction replace rather than duplicate this device's card. No periodic push, polling or dismissal-recreation job exists. Turning notification off closes this device's card, not other offline devices. Code replacement invalidates the old code on the server and reminds the patient to replace wallpaper/printed cards.

The PNG is downloaded; the patient must set it as wallpaper manually. Printable SVG is 85.6 × 54 mm and should be printed at actual size. Both contain only chosen name/code/QR/branding/sign-in instructions.

Physical-device release checks remain necessary: Android installed/uninstalled PWA, iOS Home Screen PWA, permission denial, notification click when screen is locked, lock-screen privacy settings, dismissal, duplicate replacement and SVG/PNG scanning from a real phone. The PWA cannot guarantee permanent notifications, lock-screen visibility or removal from every offline device.

## Verification commands

`npm run test` — existing backend regressions.

`npm run test:emr` — embedded PostgreSQL with every migration applied, synthetic fixtures only; Emergency Card authorization, patient isolation, revocation/expiry, hospital roles/status, rotation, unknown health facts, audit, notification and rate-limit coverage.

Frontend repository: `npm run test -- src/testing/emergencyCard.test.jsx src/testing/emergencyCardDownload.test.js` plus the full regression suite and `npm run build:telemedicine`.
