-- Workforce, part 7: HR services. Company assets (categories, a register, requests, allocations and
-- returns — separate from clinical equipment), the staff helpdesk (tickets with a per-organization
-- number, FAQs) and disciplinary queries (countersigned through the organization's "query" workflow
-- before HR records them as sent). Nothing here sends messages: "sent" records that the letter was
-- delivered.

CREATE TABLE "wf_asset_categories" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "name" VARCHAR(80) NOT NULL, "description" VARCHAR(500) NOT NULL DEFAULT '',
  CONSTRAINT "wf_asset_categories_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_asset_categories_org_id_key" UNIQUE ("organization_id", "id")
);
CREATE UNIQUE INDEX "wf_asset_categories_name_key" ON "wf_asset_categories"("organization_id", lower("name"));

CREATE TABLE "wf_company_assets" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "name" VARCHAR(120) NOT NULL, "category_id" TEXT NOT NULL, "batch_no" VARCHAR(60),
  "tracking_id" VARCHAR(60) NOT NULL, "purchase_date" DATE NOT NULL, "purchase_cost" DECIMAL(14,2) NOT NULL, "status" VARCHAR(13) NOT NULL DEFAULT 'Available',
  "expiry_date" DATE, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "wf_company_assets_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_company_assets_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_company_assets_category_fkey" FOREIGN KEY ("organization_id", "category_id") REFERENCES "wf_asset_categories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_company_assets_values_check" CHECK ("status" IN ('Available', 'In Use', 'Not Available', 'Expired') AND "purchase_cost" >= 0)
);
CREATE UNIQUE INDEX "wf_company_assets_tracking_key" ON "wf_company_assets"("organization_id", "tracking_id");

CREATE TABLE "wf_asset_requests" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "category_id" TEXT NOT NULL, "description" VARCHAR(1000) NOT NULL,
  "status" VARCHAR(9) NOT NULL DEFAULT 'Requested', "requested_by_user_id" TEXT NOT NULL, "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_by_user_id" TEXT, "decided_at" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "wf_asset_requests_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_asset_requests_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_asset_requests_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_asset_requests_category_fkey" FOREIGN KEY ("organization_id", "category_id") REFERENCES "wf_asset_categories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_asset_requests_status_check" CHECK ("status" IN ('Requested', 'Approved', 'Rejected', 'Allocated'))
);

CREATE TABLE "wf_asset_allocations" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "asset_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "request_id" TEXT,
  "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "assigned_by_user_id" TEXT NOT NULL, "returned_at" TIMESTAMP(3),
  "return_condition" VARCHAR(7), "return_note" VARCHAR(500), "received_by_user_id" TEXT,
  CONSTRAINT "wf_asset_allocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_asset_allocations_asset_fkey" FOREIGN KEY ("organization_id", "asset_id") REFERENCES "wf_company_assets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_asset_allocations_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_asset_allocations_request_fkey" FOREIGN KEY ("organization_id", "request_id") REFERENCES "wf_asset_requests"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_asset_allocations_values_check" CHECK (("returned_at" IS NULL) = ("return_condition" IS NULL) AND ("return_condition" IS NULL OR "return_condition" IN ('Good', 'Damaged', 'Lost')))
);
-- An asset is with one person at a time.
CREATE UNIQUE INDEX "wf_asset_allocations_one_open" ON "wf_asset_allocations"("organization_id", "asset_id") WHERE "returned_at" IS NULL;

CREATE TABLE "wf_tickets" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "seq" INTEGER NOT NULL, "type" VARCHAR(12) NOT NULL, "title" VARCHAR(160) NOT NULL, "description" VARCHAR(4000) NOT NULL,
  "raised_by_user_id" TEXT NOT NULL, "raised_by_employee_id" TEXT, "assigning_type" VARCHAR(12) NOT NULL, "raised_on" VARCHAR(160) NOT NULL,
  "assigned_to" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "priority" INTEGER NOT NULL, "status" VARCHAR(11) NOT NULL DEFAULT 'New',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "resolved_at" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "wf_tickets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_tickets_raiser_fkey" FOREIGN KEY ("organization_id", "raised_by_employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_tickets_values_check" CHECK (
    "type" IN ('IT Support', 'HR Complaint', 'Facilities', 'Benefits', 'General') AND "assigning_type" IN ('Individual', 'Department', 'Job Position') AND
    "priority" BETWEEN 1 AND 3 AND "status" IN ('New', 'In Progress', 'On Hold', 'Resolved') AND (("status" = 'Resolved') = ("resolved_at" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "wf_tickets_seq_key" ON "wf_tickets"("organization_id", "seq");

CREATE TABLE "wf_faq_categories" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "name" VARCHAR(80) NOT NULL,
  CONSTRAINT "wf_faq_categories_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_faq_categories_org_id_key" UNIQUE ("organization_id", "id")
);
CREATE TABLE "wf_faqs" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "category_id" TEXT NOT NULL, "question" VARCHAR(300) NOT NULL, "answer" VARCHAR(4000) NOT NULL,
  "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_faqs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_faqs_category_fkey" FOREIGN KEY ("organization_id", "category_id") REFERENCES "wf_faq_categories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "wf_queries" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "raised_by_user_id" TEXT NOT NULL, "raised_by_employee_id" TEXT,
  "subject" VARCHAR(200) NOT NULL, "body" VARCHAR(8000) NOT NULL, "status" VARCHAR(7) NOT NULL DEFAULT 'Drafted', "response_deadline_days" INTEGER NOT NULL,
  "raised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "sent_at" TIMESTAMP(3), "sent_by_user_id" TEXT, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "wf_queries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_queries_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_queries_values_check" CHECK ("status" IN ('Drafted', 'Sent') AND (("status" = 'Sent') = ("sent_at" IS NOT NULL)) AND "response_deadline_days" BETWEEN 1 AND 60 AND
    ("raised_by_employee_id" IS NULL OR "raised_by_employee_id" <> "employee_id"))
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['wf_asset_categories', 'wf_company_assets', 'wf_asset_requests', 'wf_asset_allocations', 'wf_tickets', 'wf_faq_categories', 'wf_faqs', 'wf_queries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sabi_emr_app', t);
  END LOOP;
END $$;
GRANT UPDATE ("status", "version") ON "wf_company_assets" TO sabi_emr_app;
GRANT UPDATE ("status", "decided_by_user_id", "decided_at", "version") ON "wf_asset_requests" TO sabi_emr_app;
GRANT UPDATE ("returned_at", "return_condition", "return_note", "received_by_user_id") ON "wf_asset_allocations" TO sabi_emr_app;
GRANT UPDATE ("assigned_to", "status", "resolved_at", "version") ON "wf_tickets" TO sabi_emr_app;
GRANT UPDATE ("status", "sent_at", "sent_by_user_id", "version") ON "wf_queries" TO sabi_emr_app;
