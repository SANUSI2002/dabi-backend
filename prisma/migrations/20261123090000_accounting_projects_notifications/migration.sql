-- Accounting, part 6: projects (job costing) and notification preferences.
-- A project is a cost and revenue bucket: journal lines, invoices and bills carry its id, and its P&L is
-- read from them. Time entries log hours against a project by a member of staff; billable time is pulled
-- into an invoice once (voiding that invoice frees it again). Notification preferences are each user's own
-- choice of which accounting alerts they see in the app (there is no outbound delivery).

CREATE TABLE "acct_projects" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "code" VARCHAR(20) NOT NULL, "name" VARCHAR(160) NOT NULL, "customer_id" TEXT, "status" VARCHAR(10) NOT NULL DEFAULT 'Active',
  "start_date" TIMESTAMP(3) NOT NULL, "end_date" TIMESTAMP(3), "budget_amount" DECIMAL(16,2), "billable" BOOLEAN NOT NULL DEFAULT false, "description" VARCHAR(2000),
  "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_projects_pkey" PRIMARY KEY ("id"), CONSTRAINT "acct_projects_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "acct_projects_customer_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "acct_customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_projects_check" CHECK ("status" IN ('Active', 'On Hold', 'Completed', 'Cancelled') AND ("budget_amount" IS NULL OR "budget_amount" >= 0) AND ("end_date" IS NULL OR "end_date" >= "start_date"))
);
CREATE UNIQUE INDEX "acct_projects_code_key" ON "acct_projects"("organization_id", "code");

CREATE TABLE "acct_time_entries" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "project_id" TEXT NOT NULL, "staff_employee_id" TEXT NOT NULL, "entry_date" TIMESTAMP(3) NOT NULL,
  "hours" DECIMAL(6,2) NOT NULL, "description" VARCHAR(300) NOT NULL, "billable" BOOLEAN NOT NULL, "rate" DECIMAL(16,2), "revenue_account" INTEGER NOT NULL,
  "status" VARCHAR(12) NOT NULL, "invoice_id" TEXT, "removed_at" TIMESTAMP(3), "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_time_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_time_entries_project_fkey" FOREIGN KEY ("organization_id", "project_id") REFERENCES "acct_projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_time_entries_employee_fkey" FOREIGN KEY ("organization_id", "staff_employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_time_entries_account_fkey" FOREIGN KEY ("organization_id", "revenue_account") REFERENCES "acct_accounts"("organization_id", "number") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_time_entries_check" CHECK (
    "hours" > 0 AND "hours" <= 24 AND "status" IN ('Unbilled', 'Invoiced', 'Non-billable') AND ("billable" = ("status" <> 'Non-billable')) AND ("rate" IS NULL OR "rate" >= 0)
  )
);
CREATE INDEX "acct_time_entries_project_idx" ON "acct_time_entries"("organization_id", "project_id", "status");

CREATE TABLE "acct_notification_prefs" (
  "organization_id" TEXT NOT NULL, "user_id" TEXT NOT NULL, "prefs" JSONB NOT NULL, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_notification_prefs_pkey" PRIMARY KEY ("organization_id", "user_id"),
  CONSTRAINT "acct_notification_prefs_check" CHECK (jsonb_typeof("prefs") = 'object')
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['acct_projects', 'acct_time_entries', 'acct_notification_prefs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sabi_emr_app', t);
  END LOOP;
END $$;
GRANT UPDATE ("name", "customer_id", "status", "start_date", "end_date", "budget_amount", "billable", "description", "version") ON "acct_projects" TO sabi_emr_app;
GRANT UPDATE ("status", "invoice_id", "removed_at") ON "acct_time_entries" TO sabi_emr_app;
GRANT UPDATE ("prefs", "updated_at") ON "acct_notification_prefs" TO sabi_emr_app;
