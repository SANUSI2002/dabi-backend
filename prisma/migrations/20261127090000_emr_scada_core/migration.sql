-- Equipment intelligence (SCADA), part 1: the monitored-equipment register, device keys, telemetry, the
-- equipment timeline and alarms.
--
-- Nothing here is simulated. A device (or the hospital's integration gateway) pushes heartbeats,
-- readings and events to POST /scada/ingest with its own key; equipment without a device simply shows
-- "integration not configured" — no invented readings. Keys are stored only as SHA-256 hashes and can
-- be revoked. The server evaluates each reading against the category's thresholds and raises (or keeps
-- open, never duplicates) a threshold alarm. Timeline events and readings are append-only.
--
-- Permissions reuse the equipment register's: equipment.read views, equipment.report acknowledges and
-- investigates alarms, equipment.manage registers equipment, issues device keys and closes alarms.

CREATE TABLE "emr_scada_equipment" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "tag" VARCHAR(30) NOT NULL, "asset_id" TEXT, "name" VARCHAR(160) NOT NULL, "category" VARCHAR(30) NOT NULL,
  "manufacturer" VARCHAR(120) NOT NULL DEFAULT '', "model" VARCHAR(120) NOT NULL DEFAULT '', "serial_number" VARCHAR(120) NOT NULL DEFAULT '', "ownership" VARCHAR(20) NOT NULL DEFAULT 'Owned',
  "location" JSONB NOT NULL, "procurement" JSONB NOT NULL DEFAULT '{}', "lifecycle" JSONB NOT NULL DEFAULT '{}', "technical" JSONB NOT NULL DEFAULT '{}', "compliance" JSONB NOT NULL DEFAULT '{}',
  "machine_state" VARCHAR(16) NOT NULL DEFAULT 'Unknown', "last_heartbeat_at" TIMESTAMP(3), "last_latency_ms" INTEGER, "decommissioned_at" TIMESTAMP(3),
  "registered_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "emr_scada_equipment_pkey" PRIMARY KEY ("id"), CONSTRAINT "emr_scada_equipment_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_scada_equipment_asset_fkey" FOREIGN KEY ("organization_id", "asset_id") REFERENCES "emr_assets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_scada_equipment_check" CHECK (
    "category" IN ('Laboratory Analyzer', 'Radiology Imaging', 'ICU Device', 'Theatre Equipment', 'Dialysis Equipment', 'Pharmacy Cold Chain', 'Generator', 'HVAC', 'Medical Gas',
      'Water Treatment', 'Solar / Inverter', 'Elevator', 'Other Infrastructure') AND
    "machine_state" IN ('Unknown', 'Offline', 'Powered Off', 'Starting', 'Ready', 'Idle', 'Running', 'Warning', 'Error', 'Critical', 'Maintenance', 'Calibration', 'Decommissioned') AND
    jsonb_typeof("location") = 'object'
  )
);
CREATE UNIQUE INDEX "emr_scada_equipment_tag_key" ON "emr_scada_equipment"("organization_id", "tag");

-- A device's key: "sdk.<organizationId>.<keyId>.<secret>"; only the secret's SHA-256 is kept.
CREATE TABLE "emr_scada_device_keys" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "equipment_id" TEXT NOT NULL, "label" VARCHAR(80) NOT NULL, "secret_hash" CHAR(64) NOT NULL,
  "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "last_used_at" TIMESTAMP(3), "revoked_at" TIMESTAMP(3), "revoked_by_user_id" TEXT,
  CONSTRAINT "emr_scada_device_keys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_scada_device_keys_equipment_fkey" FOREIGN KEY ("organization_id", "equipment_id") REFERENCES "emr_scada_equipment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "emr_scada_readings" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "equipment_id" TEXT NOT NULL, "parameter" VARCHAR(40) NOT NULL, "value" DOUBLE PRECISION NOT NULL,
  "severity" VARCHAR(8) NOT NULL, "recorded_at" TIMESTAMP(3) NOT NULL, "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "device_key_id" TEXT NOT NULL,
  CONSTRAINT "emr_scada_readings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_scada_readings_equipment_fkey" FOREIGN KEY ("organization_id", "equipment_id") REFERENCES "emr_scada_equipment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_scada_readings_check" CHECK ("severity" IN ('Normal', 'Warning', 'Critical'))
);
CREATE INDEX "emr_scada_readings_series_idx" ON "emr_scada_readings"("organization_id", "equipment_id", "parameter", "recorded_at");

CREATE TABLE "emr_scada_events" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "equipment_id" TEXT NOT NULL, "type" VARCHAR(24) NOT NULL, "at" TIMESTAMP(3) NOT NULL, "source" VARCHAR(14) NOT NULL,
  "actor" VARCHAR(160), "detail" VARCHAR(1000), "patient_id" TEXT, "related_order_id" TEXT, "correlation_id" VARCHAR(80) NOT NULL, "idempotency_key" VARCHAR(120) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_scada_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_scada_events_equipment_fkey" FOREIGN KEY ("organization_id", "equipment_id") REFERENCES "emr_scada_equipment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_scada_events_check" CHECK ("source" IN ('DEVICE_GATEWAY', 'USER', 'SYSTEM'))
);
-- a repeated delivery of the same event is recorded once
CREATE UNIQUE INDEX "emr_scada_events_idempotency_key" ON "emr_scada_events"("organization_id", "equipment_id", "idempotency_key");
CREATE INDEX "emr_scada_events_timeline_idx" ON "emr_scada_events"("organization_id", "equipment_id", "at");

CREATE TABLE "emr_scada_alarms" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "equipment_id" TEXT NOT NULL, "raised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "source" VARCHAR(14) NOT NULL,
  "severity" VARCHAR(13) NOT NULL, "category" VARCHAR(22) NOT NULL, "description" VARCHAR(1000) NOT NULL, "parameter" VARCHAR(40), "value" DOUBLE PRECISION, "threshold" DOUBLE PRECISION,
  "status" VARCHAR(13) NOT NULL DEFAULT 'Raised', "dedup_key" VARCHAR(120),
  "acknowledged_by_user_id" TEXT, "acknowledged_at" TIMESTAMP(3), "investigation_note" VARCHAR(2000), "escalated_to" VARCHAR(160), "escalated_at" TIMESTAMP(3),
  "resolution" VARCHAR(2000), "resolved_by_user_id" TEXT, "resolved_at" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "emr_scada_alarms_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_scada_alarms_equipment_fkey" FOREIGN KEY ("organization_id", "equipment_id") REFERENCES "emr_scada_equipment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_scada_alarms_check" CHECK (
    "source" IN ('DEVICE_GATEWAY', 'USER', 'SYSTEM') AND "severity" IN ('Informational', 'Low', 'Medium', 'High', 'Critical', 'Emergency') AND
    "status" IN ('Raised', 'Acknowledged', 'Investigating', 'Escalated', 'Resolved', 'Closed', 'Suppressed') AND
    "category" IN ('Threshold Breach', 'Connectivity', 'Calibration', 'Maintenance', 'Safety', 'Unauthorized Activity', 'Consumable', 'Warranty', 'Power', 'Other')
  )
);
-- at most one open alarm per cause (e.g. the same parameter on the same equipment)
CREATE UNIQUE INDEX "emr_scada_alarms_open_key" ON "emr_scada_alarms"("organization_id", "dedup_key") WHERE "dedup_key" IS NOT NULL AND "status" IN ('Raised', 'Acknowledged', 'Investigating', 'Escalated');
CREATE INDEX "emr_scada_alarms_equipment_idx" ON "emr_scada_alarms"("organization_id", "equipment_id", "raised_at");

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['emr_scada_equipment', 'emr_scada_device_keys', 'emr_scada_readings', 'emr_scada_events', 'emr_scada_alarms'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sabi_emr_app', t);
  END LOOP;
END $$;
GRANT UPDATE ("asset_id", "name", "manufacturer", "model", "serial_number", "ownership", "location", "procurement", "lifecycle", "technical", "compliance",
  "machine_state", "last_heartbeat_at", "last_latency_ms", "decommissioned_at", "version") ON "emr_scada_equipment" TO sabi_emr_app;
GRANT UPDATE ("last_used_at", "revoked_at", "revoked_by_user_id") ON "emr_scada_device_keys" TO sabi_emr_app;
GRANT UPDATE ("value", "status", "acknowledged_by_user_id", "acknowledged_at", "investigation_note", "escalated_to", "escalated_at", "resolution", "resolved_by_user_id",
  "resolved_at", "version") ON "emr_scada_alarms" TO sabi_emr_app;
