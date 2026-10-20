# Google AI runtime / existing API release

The public API remains on Render until the separate full Google production cutover. A small,
request-scoped Cloud Run service can hold the Google workload identity while the existing API
retains durable PostgreSQL jobs, user authentication, ownership, consent and request allowances.
This is an incremental provider connection, not migration of PostgreSQL or public domains.

The gateway has no database credentials, user sessions, storage access or interval worker. Its
only model destination is the server-configured Vertex model. It requires a 256-bit HMAC secret,
request-body signature and timestamp on every generation request. It accepts bounded text chat
only; arbitrary tools, external URLs, model selection and inline document data are rejected.
Errors and health responses contain no credentials or medical text. No request-body logging.

Deploy Dockerfile target `ai-runtime`, with the existing `sabi-ai-production` identity, min 0,
max 1, concurrency 4, request-billed 1 CPU / 512 MiB and a 60-second request deadline. The caller
uses a 55-second deadline; the Vertex adapter uses 45 seconds. Keep patient document extraction
off for this chat-only runtime. JEV and licensed EMDEX activation remain separate workflows.

Google runtime: `SABI_AI_PROVIDER=vertex`, `SABI_AI_AUTH_MODE=adc`, explicit official project ID,
explicit model, and `SABI_AI_GATEWAY_SECRET` from a dedicated Secret Manager version. Render API:
`SABI_AI_PROVIDER=gateway`, `SABI_AI_AUTH_MODE=gateway`, the same model, exact Cloud Run base URL,
shared secret and enabled/processing-approved switches. Never copy a Google service-account key.
Do not display secrets, put them in CLI arguments, browser bundles, build arguments or Git.

Configure the secret binding, gateway exposure and Render connection only after the user's
specific approval. Keep the old provider configuration available for a deliberate rollback.
Verify unsigned denial, fixed synthetic generation, durable authenticated patient conversation,
reload, account isolation and cancellation. HTTP 200 of a SPA is not verification.

This checkpoint is not deployed yet. Cloud Shell access was approved; no resource or secret
creation, public invoker permission or Render environment change is implied by that authorization.
