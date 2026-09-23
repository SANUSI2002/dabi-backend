# Production rate-limiting checklist

- Rate limits are process-local: deploy one API instance. Counters reset when
  this process restarts.
- A shared rate-limit store is required only before horizontal scaling to
  multiple API instances.
- Set `RATE_LIMIT_KEY_SECRET` to an independent high-entropy secret.
- Do not set `TRUST_PROXY=true`. Set `TRUST_PROXY_HOPS=1` only when exactly one
  known reverse proxy sits in front of the service, or set `TRUST_PROXY_CIDRS`
  to a comma-separated allowlist supplied by infrastructure.
- Enforce complementary gateway/CDN limits, WAF/bot controls, alerting, and monitoring.
- CAPTCHA and step-up authentication are intentionally deferred external controls.
