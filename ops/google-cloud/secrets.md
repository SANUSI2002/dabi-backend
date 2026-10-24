# Production secret references

Project: `project-2dfff4eb-ff04-40b1-aff`. Values must never be written here,
in build arguments, in logs, in Git, or in frontend environment variables.
Pin enabled version numbers in Cloud Run revisions rather than `latest`.

| Environment variable | Secret ID | Identity access |
| --- | --- | --- |
| RESEND_API_KEY | sabi-prod-resend-api-key | API, worker |
| CLOUDMERSIVE_API_KEY | sabi-prod-cloudmersive-api-key | API, worker |
| DAILY_API_KEY | sabi-prod-daily-api-key | API, worker |
| GOOGLE_OAUTH_CLIENT_ID | sabi-prod-google-oauth-client-id | API |
| GOOGLE_OAUTH_CLIENT_SECRET | sabi-prod-google-oauth-client-secret | API |
| JWT_SECRET | sabi-prod-jwt-secret | API |
| JWT_REFRESH_SECRET | sabi-prod-jwt-refresh-secret | API |
| RATE_LIMIT_KEY_SECRET | sabi-prod-rate-limit-key-secret | API |
| MFA_ENCRYPTION_KEY | sabi-prod-mfa-encryption-key | API |
| WEB_PUSH_ACTION_SECRET | sabi-prod-web-push-action-secret | API, worker |
| ORDER_DELIVERY_ENCRYPTION_KEY | sabi-prod-order-delivery-encryption-key | API, worker |
| EMR_SECRET_KEY | sabi-prod-emr-secret-key | API, worker |
| SABI_AI_GATEWAY_SECRET | sabi-ai-gateway-secret | API, worker, existing AI runtime |
| TYPESAFE_API_KEY | typesafe-api-key | API, worker, existing AI runtime |

The first five were transferred from the existing Render configuration with
explicit approval. Seven new independent 256-bit server secrets were generated
directly into Secret Manager, never printed or stored in a local file. AES keys
are base64-encoded; JWT, rate-limit and push-action keys are hex-encoded.
The two pre-existing AI secrets were retained, not rotated.

Each accessor binding is on that individual secret, not the project. API/worker
have no secret administration or version creation permissions. Neither gets the
other's database identity, a database password, a Supabase key or a downloaded
Google service-account key. The migration identity receives none of these secrets.

`CLOUDMERSIVE_API_KEY` also serves the API's existing readiness/configuration
checks; `DAILY_API_KEY` serves interactive room creation and worker room cleanup.
The signing and MFA secrets have not been shared with the worker. A future worker
step that actually needs an additional secret requires a reviewed mapping change.

No Paystack, WhatsApp, EMDEX, Google Routes or VAPID provider credential existed
in the inspected Render environment. Do not invent working integrations or
silently fall back to another provider. Preserve the existing explicit
configuration checks and report any missing provider during acceptance testing.

IAM creation and enabled versions do not prove email, OAuth, scanning or video
work end-to-end. Check those through the deployed application before cutover.
