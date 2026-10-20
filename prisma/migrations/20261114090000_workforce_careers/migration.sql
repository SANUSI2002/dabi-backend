-- Workforce, part 5: careers. Performance (review periods, a key-result catalogue, objectives assigned
-- to employees with their key results, 360° feedback, 1-on-1 meetings), promotions and branch
-- transfers. A promotion or transfer is approved through the organization's "promotion" / "transfer"
-- workflow; applying it changes the employee record, then the outgoing work is handed over.

CREATE TABLE "wf_review_periods" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "name" VARCHAR(80) NOT NULL, "start_date" DATE NOT NULL, "end_date" DATE NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_review_periods_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_review_periods_dates_check" CHECK ("end_date" >= "start_date")
);

CREATE TABLE "wf_key_results" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "title" VARCHAR(160) NOT NULL, "type" VARCHAR(10) NOT NULL, "target_value" DECIMAL(14,2) NOT NULL,
  CONSTRAINT "wf_key_results_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_key_results_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_key_results_values_check" CHECK ("type" IN ('Numeric', 'Percentage', 'Boolean') AND "target_value" > 0)
);

CREATE TABLE "wf_objectives" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "title" VARCHAR(160) NOT NULL, "description" VARCHAR(2000) NOT NULL DEFAULT '',
  "manager_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "assignee_ids" TEXT[] NOT NULL, "key_result_ids" TEXT[] NOT NULL,
  "duration_unit" VARCHAR(6) NOT NULL, "duration" INTEGER NOT NULL, "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_objectives_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_objectives_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_objectives_values_check" CHECK ("duration_unit" IN ('Days', 'Months', 'Years') AND "duration" BETWEEN 1 AND 3650 AND cardinality("assignee_ids") >= 1 AND cardinality("key_result_ids") >= 1)
);

CREATE TABLE "wf_employee_objectives" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "objective_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "start_date" TIMESTAMP(3) NOT NULL, "end_date" TIMESTAMP(3) NOT NULL,
  "status" VARCHAR(11) NOT NULL DEFAULT 'Not Started', "progress" INTEGER NOT NULL DEFAULT 0, "key_results" JSONB NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "wf_employee_objectives_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_employee_objectives_objective_fkey" FOREIGN KEY ("organization_id", "objective_id") REFERENCES "wf_objectives"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_employee_objectives_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_employee_objectives_values_check" CHECK ("status" IN ('Not Started', 'On Track', 'Behind', 'At Risk', 'Closed') AND "progress" BETWEEN 0 AND 100 AND jsonb_typeof("key_results") = 'array')
);

CREATE TABLE "wf_feedback" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "review_cycle" VARCHAR(80) NOT NULL, "employee_id" TEXT NOT NULL, "manager_id" TEXT,
  "colleague_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "status" VARCHAR(11) NOT NULL DEFAULT 'In Progress', "start_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "end_date" TIMESTAMP(3), "self_answers" JSONB, "manager_answers" JSONB, "started_by_user_id" TEXT NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "wf_feedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_feedback_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_feedback_manager_fkey" FOREIGN KEY ("organization_id", "manager_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_feedback_values_check" CHECK ("status" IN ('In Progress', 'Closed') AND (("status" = 'Closed') = ("self_answers" IS NOT NULL AND "manager_answers" IS NOT NULL)) AND ("manager_id" IS NULL OR "manager_id" <> "employee_id"))
);

CREATE TABLE "wf_meetings" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "title" VARCHAR(120) NOT NULL, "employee_id" TEXT NOT NULL, "manager_id" TEXT NOT NULL,
  "scheduled_at" TIMESTAMP(3) NOT NULL, "status" VARCHAR(9) NOT NULL DEFAULT 'Scheduled', "notes" VARCHAR(4000), "action_items" VARCHAR(4000),
  "created_by_user_id" TEXT NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "wf_meetings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_meetings_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_meetings_manager_fkey" FOREIGN KEY ("organization_id", "manager_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_meetings_values_check" CHECK ("status" IN ('Scheduled', 'Completed') AND ("status" <> 'Completed' OR "notes" IS NOT NULL))
);

CREATE TABLE "wf_promotions" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "from_job_position_id" TEXT, "from_job_role_id" TEXT, "from_cadre" VARCHAR(80),
  "to_job_position_id" TEXT, "to_job_role_id" TEXT, "to_cadre" VARCHAR(80), "new_salary" DECIMAL(14,2), "effective_date" DATE NOT NULL, "reason" VARCHAR(2000) NOT NULL,
  "status" VARCHAR(9) NOT NULL DEFAULT 'Proposed', "applied_at" TIMESTAMP(3), "successor_id" TEXT, "handover_notes" VARCHAR(4000),
  "handover_status" VARCHAR(11) NOT NULL DEFAULT 'Not started', "handover_completed_at" TIMESTAMP(3), "requested_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "wf_promotions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_promotions_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_promotions_position_fkey" FOREIGN KEY ("organization_id", "to_job_position_id") REFERENCES "wf_job_positions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_promotions_successor_fkey" FOREIGN KEY ("organization_id", "successor_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_promotions_values_check" CHECK (
    "status" IN ('Proposed', 'Effective') AND "handover_status" IN ('Not started', 'In progress', 'Complete') AND
    ("to_job_position_id" IS NOT NULL OR "to_job_role_id" IS NOT NULL OR "to_cadre" IS NOT NULL) AND ("new_salary" IS NULL OR "new_salary" > 0) AND
    (("status" = 'Effective') = ("applied_at" IS NOT NULL)) AND ("successor_id" IS NULL OR "successor_id" <> "employee_id")
  )
);

CREATE TABLE "wf_branch_transfers" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "from_company_id" TEXT, "to_company_id" TEXT NOT NULL,
  "effective_date" DATE NOT NULL, "reason" VARCHAR(2000) NOT NULL, "status" VARCHAR(9) NOT NULL DEFAULT 'Proposed', "applied_at" TIMESTAMP(3),
  "successor_id" TEXT, "handover_notes" VARCHAR(4000), "handover_status" VARCHAR(11) NOT NULL DEFAULT 'Not started', "handover_completed_at" TIMESTAMP(3),
  "requested_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "wf_branch_transfers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_branch_transfers_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_branch_transfers_company_fkey" FOREIGN KEY ("organization_id", "to_company_id") REFERENCES "wf_companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_branch_transfers_successor_fkey" FOREIGN KEY ("organization_id", "successor_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_branch_transfers_values_check" CHECK (
    "status" IN ('Proposed', 'Effective') AND "handover_status" IN ('Not started', 'In progress', 'Complete') AND
    (("status" = 'Effective') = ("applied_at" IS NOT NULL)) AND ("from_company_id" IS NULL OR "from_company_id" <> "to_company_id") AND ("successor_id" IS NULL OR "successor_id" <> "employee_id")
  )
);
-- One change of each kind in flight per employee.
CREATE UNIQUE INDEX "wf_promotions_one_proposed" ON "wf_promotions"("organization_id", "employee_id") WHERE "status" = 'Proposed';
CREATE UNIQUE INDEX "wf_branch_transfers_one_proposed" ON "wf_branch_transfers"("organization_id", "employee_id") WHERE "status" = 'Proposed';

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['wf_review_periods', 'wf_key_results', 'wf_objectives', 'wf_employee_objectives', 'wf_feedback', 'wf_meetings', 'wf_promotions', 'wf_branch_transfers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sabi_emr_app', t);
  END LOOP;
END $$;
GRANT UPDATE ("status", "progress", "key_results", "version") ON "wf_employee_objectives" TO sabi_emr_app;
GRANT UPDATE ("status", "end_date", "self_answers", "manager_answers", "version") ON "wf_feedback" TO sabi_emr_app;
GRANT UPDATE ("status", "notes", "action_items", "version") ON "wf_meetings" TO sabi_emr_app;
GRANT UPDATE ("status", "applied_at", "successor_id", "handover_notes", "handover_status", "handover_completed_at", "version") ON "wf_promotions", "wf_branch_transfers" TO sabi_emr_app;
