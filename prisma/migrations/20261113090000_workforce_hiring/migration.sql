-- Workforce, part 4: hiring and exits. Recruitment (requisitions with their pipeline stages,
-- candidates, interviews), the talent pool (profiles, notes, documents, history), vacancy requests
-- (approved through the "vacancy" workflow), onboarding (a fixed checklist; HR review through the
-- "onboarding" workflow, then conversion creates the employee record) and offboarding (a fixed exit
-- pipeline; archiving deactivates the employee). Documents are recorded by name — no files are stored.

CREATE TABLE "wf_requisitions" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "title" VARCHAR(160) NOT NULL, "description" VARCHAR(2000) NOT NULL DEFAULT '',
  "department_id" TEXT, "job_position_id" TEXT, "vacancy" INTEGER NOT NULL, "manager_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "start_date" DATE NOT NULL, "end_date" DATE, "closed" BOOLEAN NOT NULL DEFAULT false, "created_by_user_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_requisitions_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_requisitions_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_requisitions_department_fkey" FOREIGN KEY ("organization_id", "department_id") REFERENCES "wf_departments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_requisitions_position_fkey" FOREIGN KEY ("organization_id", "job_position_id") REFERENCES "wf_job_positions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_requisitions_values_check" CHECK ("vacancy" BETWEEN 1 AND 500 AND ("end_date" IS NULL OR "end_date" >= "start_date"))
);

CREATE TABLE "wf_pipeline_stages" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "requisition_id" TEXT NOT NULL, "name" VARCHAR(80) NOT NULL, "type" VARCHAR(9) NOT NULL, "sequence" INTEGER NOT NULL,
  CONSTRAINT "wf_pipeline_stages_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_pipeline_stages_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_pipeline_stages_requisition_fkey" FOREIGN KEY ("organization_id", "requisition_id") REFERENCES "wf_requisitions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_pipeline_stages_type_check" CHECK ("type" IN ('Initial', 'Applied', 'Test', 'Interview', 'Hired', 'Cancelled') AND "sequence" BETWEEN 0 AND 50)
);
CREATE UNIQUE INDEX "wf_pipeline_stages_sequence_key" ON "wf_pipeline_stages"("organization_id", "requisition_id", "sequence");

CREATE TABLE "wf_candidates" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "requisition_id" TEXT NOT NULL, "stage_id" TEXT NOT NULL, "name" VARCHAR(160) NOT NULL,
  "email" VARCHAR(160) NOT NULL, "phone" VARCHAR(30) NOT NULL DEFAULT '', "source" VARCHAR(15) NOT NULL, "referred_by_employee_id" TEXT,
  "rating" INTEGER NOT NULL DEFAULT 0, "hired" BOOLEAN NOT NULL DEFAULT false, "canceled" BOOLEAN NOT NULL DEFAULT false, "cancel_reason" VARCHAR(200),
  "converted_employee_id" TEXT, "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "wf_candidates_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_candidates_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_candidates_requisition_fkey" FOREIGN KEY ("organization_id", "requisition_id") REFERENCES "wf_requisitions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_candidates_stage_fkey" FOREIGN KEY ("organization_id", "stage_id") REFERENCES "wf_pipeline_stages"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_candidates_referrer_fkey" FOREIGN KEY ("organization_id", "referred_by_employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_candidates_employee_fkey" FOREIGN KEY ("organization_id", "converted_employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_candidates_values_check" CHECK ("source" IN ('Application', 'Referral', 'Inside software') AND "rating" BETWEEN 0 AND 5 AND ("canceled" = false OR "cancel_reason" IS NOT NULL) AND NOT ("hired" AND "canceled"))
);

CREATE TABLE "wf_interviews" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "candidate_id" TEXT NOT NULL, "scheduled_at" TIMESTAMP(3) NOT NULL, "interviewer_ids" TEXT[] NOT NULL,
  "notes" VARCHAR(1000), "status" VARCHAR(9) NOT NULL DEFAULT 'Scheduled', "feedback" VARCHAR(2000), "created_by_user_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_interviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_interviews_candidate_fkey" FOREIGN KEY ("organization_id", "candidate_id") REFERENCES "wf_candidates"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_interviews_values_check" CHECK ("status" IN ('Scheduled', 'Completed', 'Cancelled') AND cardinality("interviewer_ids") BETWEEN 1 AND 10 AND ("status" <> 'Completed' OR "feedback" IS NOT NULL))
);

CREATE TABLE "wf_talent_pool" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "skill_zone" VARCHAR(80) NOT NULL, "candidate_name" VARCHAR(160) NOT NULL, "email" VARCHAR(160) NOT NULL DEFAULT '',
  "phone" VARCHAR(30) NOT NULL DEFAULT '', "reason" VARCHAR(500) NOT NULL, "from_candidate_id" TEXT, "profile" JSONB NOT NULL DEFAULT '{}',
  "taken_requisition_id" TEXT, "taken_candidate_id" TEXT, "taken_status_code" VARCHAR(40), "taken_at" TIMESTAMP(3), "added_by_user_id" TEXT NOT NULL,
  "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_talent_pool_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_talent_pool_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_talent_pool_candidate_fkey" FOREIGN KEY ("organization_id", "from_candidate_id") REFERENCES "wf_candidates"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_talent_pool_taken_fkey" FOREIGN KEY ("organization_id", "taken_candidate_id") REFERENCES "wf_candidates"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_talent_pool_values_check" CHECK (jsonb_typeof("profile") = 'object' AND (("taken_candidate_id" IS NULL) = ("taken_at" IS NULL)))
);
CREATE UNIQUE INDEX "wf_talent_pool_from_candidate_key" ON "wf_talent_pool"("organization_id", "from_candidate_id") WHERE "from_candidate_id" IS NOT NULL;

-- Append-only: notes, documents (by name) and history on a talent-pool profile.
CREATE TABLE "wf_talent_entries" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "talent_id" TEXT NOT NULL, "kind" VARCHAR(8) NOT NULL,
  "text" VARCHAR(2000) NOT NULL, "detail" VARCHAR(300), "size_kb" INTEGER, "by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_talent_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_talent_entries_talent_fkey" FOREIGN KEY ("organization_id", "talent_id") REFERENCES "wf_talent_pool"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_talent_entries_kind_check" CHECK ("kind" IN ('note', 'document', 'history') AND ("size_kb" IS NULL OR "size_kb" BETWEEN 0 AND 102400))
);
CREATE INDEX "wf_talent_entries_talent_idx" ON "wf_talent_entries"("organization_id", "talent_id", "created_at");

CREATE TABLE "wf_vacancies" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "department_id" TEXT NOT NULL, "job_position_id" TEXT, "role_title" VARCHAR(160) NOT NULL,
  "headcount" INTEGER NOT NULL, "vacancy_type_id" VARCHAR(60), "reason" VARCHAR(2000) NOT NULL, "requirements" VARCHAR(2000),
  "salary_min" DECIMAL(14,2), "salary_max" DECIMAL(14,2), "raised_by_user_id" TEXT NOT NULL, "raised_by_employee_id" TEXT,
  "status" VARCHAR(9) NOT NULL DEFAULT 'Draft', "rejection_reason" VARCHAR(500), "requisition_id" TEXT,
  "submitted_at" TIMESTAMP(3), "decided_at" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 1, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_vacancies_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_vacancies_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_vacancies_department_fkey" FOREIGN KEY ("organization_id", "department_id") REFERENCES "wf_departments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_vacancies_position_fkey" FOREIGN KEY ("organization_id", "job_position_id") REFERENCES "wf_job_positions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_vacancies_raiser_fkey" FOREIGN KEY ("organization_id", "raised_by_employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_vacancies_requisition_fkey" FOREIGN KEY ("organization_id", "requisition_id") REFERENCES "wf_requisitions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_vacancies_values_check" CHECK (
    "status" IN ('Draft', 'Submitted', 'Approved', 'Rejected', 'Filled', 'Cancelled') AND "headcount" BETWEEN 1 AND 500 AND
    ("salary_min" IS NULL OR "salary_min" >= 0) AND ("salary_max" IS NULL OR "salary_max" >= COALESCE("salary_min", 0)) AND
    ("status" <> 'Rejected' OR "rejection_reason" IS NOT NULL)
  )
);

CREATE TABLE "wf_onboarding" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "candidate_id" TEXT NOT NULL, "candidate_name" VARCHAR(160) NOT NULL, "requisition_id" TEXT NOT NULL,
  "job_position_id" TEXT, "department_id" TEXT, "current_stage_id" VARCHAR(20) NOT NULL, "task_done" JSONB NOT NULL DEFAULT '{}',
  "resumption_date" DATE, "basic_salary" DECIMAL(14,2), "employee_id" TEXT, "started_by_user_id" TEXT NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completed_at" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "wf_onboarding_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_onboarding_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_onboarding_candidate_fkey" FOREIGN KEY ("organization_id", "candidate_id") REFERENCES "wf_candidates"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_onboarding_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_onboarding_values_check" CHECK (jsonb_typeof("task_done") = 'object' AND ("basic_salary" IS NULL OR "basic_salary" > 0))
);
CREATE UNIQUE INDEX "wf_onboarding_candidate_key" ON "wf_onboarding"("organization_id", "candidate_id");

CREATE TABLE "wf_onboarding_documents" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "onboarding_id" TEXT NOT NULL, "task_id" VARCHAR(20) NOT NULL, "title" VARCHAR(200) NOT NULL,
  "uploaded_by_user_id" TEXT NOT NULL, "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_onboarding_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_onboarding_documents_onboarding_fkey" FOREIGN KEY ("organization_id", "onboarding_id") REFERENCES "wf_onboarding"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "wf_hr_settings" (
  "organization_id" TEXT NOT NULL, "offer_letter_template" VARCHAR(20000) NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  "updated_by_user_id" TEXT, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_hr_settings_pkey" PRIMARY KEY ("organization_id")
);

CREATE TABLE "wf_offboarding" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "reason" VARCHAR(120) NOT NULL, "notice_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_working_date" DATE NOT NULL, "current_stage_id" VARCHAR(20) NOT NULL, "status" VARCHAR(9) NOT NULL DEFAULT 'Ongoing',
  "exit_interview_notes" VARCHAR(4000), "handover_notes" VARCHAR(4000), "fnf_amount" DECIMAL(14,2), "fnf_settled" BOOLEAN NOT NULL DEFAULT false,
  "started_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completed_at" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "wf_offboarding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_offboarding_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_offboarding_values_check" CHECK ("status" IN ('Ongoing', 'Completed') AND (("status" = 'Completed') = ("completed_at" IS NOT NULL)) AND ("fnf_settled" = false OR "fnf_amount" > 0))
);
CREATE UNIQUE INDEX "wf_offboarding_one_ongoing" ON "wf_offboarding"("organization_id", "employee_id") WHERE "status" = 'Ongoing';

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['wf_requisitions', 'wf_pipeline_stages', 'wf_candidates', 'wf_interviews', 'wf_talent_pool', 'wf_talent_entries', 'wf_vacancies',
    'wf_onboarding', 'wf_onboarding_documents', 'wf_hr_settings', 'wf_offboarding'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sabi_emr_app', t);
  END LOOP;
END $$;
GRANT UPDATE ("closed", "version") ON "wf_requisitions" TO sabi_emr_app;
GRANT UPDATE ("stage_id", "rating", "hired", "canceled", "cancel_reason", "converted_employee_id", "version") ON "wf_candidates" TO sabi_emr_app;
GRANT UPDATE ("status", "feedback", "version") ON "wf_interviews" TO sabi_emr_app;
GRANT UPDATE ("taken_requisition_id", "taken_candidate_id", "taken_status_code", "taken_at") ON "wf_talent_pool" TO sabi_emr_app;
GRANT UPDATE ("department_id", "job_position_id", "role_title", "headcount", "vacancy_type_id", "reason", "requirements", "salary_min", "salary_max",
  "status", "rejection_reason", "requisition_id", "submitted_at", "decided_at", "version") ON "wf_vacancies" TO sabi_emr_app;
GRANT UPDATE ("current_stage_id", "task_done", "resumption_date", "basic_salary", "employee_id", "completed_at", "version") ON "wf_onboarding" TO sabi_emr_app;
GRANT UPDATE ("offer_letter_template", "version", "updated_by_user_id", "updated_at") ON "wf_hr_settings" TO sabi_emr_app;
GRANT UPDATE ("current_stage_id", "status", "exit_interview_notes", "handover_notes", "fnf_amount", "fnf_settled", "completed_at", "version") ON "wf_offboarding" TO sabi_emr_app;
