# EMR patient registry: gated test slice

The new `/api/v1/emr/organizations/:organizationId/patients` routes are deployed **disabled**. Do not set `EMR_PATIENT_REGISTRY_ENABLED=true` on the current Render test API while it uses the disposable database without backups. Never enter real patient data in this release.

When enabled in an appropriate test environment, a request needs all of the following:

1. A signed-in Sabi ID with an active membership for the organization in the JWT.
2. The path organization ID matching that signed organization context.
3. An approved hospital application, completed owner setup, and a published package containing `emr`.
4. `patient.read` to list/search or `patient.register` to create a record.

The API assigns the organization ID and registrar from the signed context; neither is accepted from request JSON. Medical record numbers are unique **within** an organization, not globally. Reads and registrations create activity-log entries. The frontend shows a synthetic-data-only warning. The patient registry is separate from Sabi ID patient accounts.

Before enabling for real clinical use, provide a durable database with tested backups and restore, database-enforced tenant isolation (including PostgreSQL row-level security), a retention policy, production audit review, and a completed privacy/security assessment. The hospital-document scanner and manual authenticity review are separate requirements for initial EMR approval and remain disabled until an always-on ClamAV host is available.
