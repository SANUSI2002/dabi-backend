-- Workforce, part 3: the approval workflow engine. Definitions are the organization's own graphs
-- (seeded with six starters, edited in the Workflow Builder). An instance keeps a snapshot of the graph
-- it started on, so editing a definition never changes requests already in flight. Approvers are
-- resolved by the server from the organization's people records; the decision trail is insert-only.

CREATE TABLE "wf_workflow_defs" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "starter_key" VARCHAR(30), "name" VARCHAR(120) NOT NULL, "description" VARCHAR(500),
  "trigger_type" VARCHAR(40) NOT NULL, "active" BOOLEAN NOT NULL DEFAULT false, "nodes" JSONB NOT NULL, "edges" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1, "created_by_user_id" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_workflow_defs_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_workflow_defs_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_workflow_defs_values_check" CHECK ("trigger_type" ~ '^[a-z][a-z0-9-]{1,39}$' AND jsonb_typeof("nodes") = 'array' AND jsonb_typeof("edges") = 'array')
);
CREATE UNIQUE INDEX "wf_workflow_defs_starter_key" ON "wf_workflow_defs"("organization_id", "starter_key") WHERE "starter_key" IS NOT NULL;

CREATE TABLE "wf_workflow_instances" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "def_id" TEXT NOT NULL, "def_name" VARCHAR(120) NOT NULL, "def_version" INTEGER NOT NULL,
  "graph" JSONB NOT NULL, "trigger_type" VARCHAR(40) NOT NULL, "subject" VARCHAR(300) NOT NULL, "reference" VARCHAR(100) NOT NULL, "context" JSONB NOT NULL,
  "is_test" BOOLEAN NOT NULL DEFAULT false, "initiated_by_user_id" TEXT NOT NULL, "initiated_by_employee_id" TEXT,
  "status" VARCHAR(9) NOT NULL DEFAULT 'Running', "active" JSONB NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completed_at" TIMESTAMP(3),
  CONSTRAINT "wf_workflow_instances_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_workflow_instances_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_workflow_instances_def_fkey" FOREIGN KEY ("organization_id", "def_id") REFERENCES "wf_workflow_defs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_workflow_instances_initiator_fkey" FOREIGN KEY ("organization_id", "initiated_by_employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_workflow_instances_values_check" CHECK (
    "status" IN ('Running', 'Approved', 'Rejected', 'Cancelled') AND jsonb_typeof("active") = 'array' AND jsonb_typeof("context") = 'object' AND
    (("status" = 'Running') = ("completed_at" IS NULL))
  )
);
-- One request in flight per document.
CREATE UNIQUE INDEX "wf_workflow_instances_one_running" ON "wf_workflow_instances"("organization_id", "trigger_type", "reference") WHERE "status" = 'Running';
CREATE INDEX "wf_workflow_instances_org_created_idx" ON "wf_workflow_instances"("organization_id", "created_at");

CREATE TABLE "wf_workflow_events" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "instance_id" TEXT NOT NULL, "node_id" VARCHAR(60) NOT NULL, "node_label" VARCHAR(160) NOT NULL,
  "action" VARCHAR(10) NOT NULL, "actor_user_id" TEXT, "actor_employee_id" TEXT, "comment" VARCHAR(500), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_workflow_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_workflow_events_instance_fkey" FOREIGN KEY ("organization_id", "instance_id") REFERENCES "wf_workflow_instances"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_workflow_events_action_check" CHECK ("action" IN ('started', 'entered', 'approved', 'rejected', 'escalated', 'notified', 'auto', 'completed', 'cancelled'))
);
CREATE INDEX "wf_workflow_events_instance_idx" ON "wf_workflow_events"("organization_id", "instance_id", "created_at");

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['wf_workflow_defs', 'wf_workflow_instances', 'wf_workflow_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sabi_emr_app', t);
  END LOOP;
END $$;
GRANT UPDATE ("name", "description", "trigger_type", "active", "nodes", "edges", "version", "updated_at") ON "wf_workflow_defs" TO sabi_emr_app;
GRANT UPDATE ("status", "active", "version", "completed_at") ON "wf_workflow_instances" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('workflow.manage', 'Design and switch on approval workflows, see every request in flight and cancel or escalate them')
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('HR_OFFICER', 'workflow.manage'), ('HOSPITAL_ADMIN', 'workflow.manage'), ('ORGANISATION_OWNER', 'workflow.manage')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
