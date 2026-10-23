-- Workforce product, part 1: organization structure and people (HR core). Same tenancy as the EMR
-- (organization_id + RLS through emr_current_organization(), the sabi_emr_app role), gated by the
-- 'workforce' product entitlement. An employee is an HR record, optionally linked to a Sabi user
-- (staff with no login — porters, cleaners — are employees too). Bank details are sensitive and only
-- returned to HR roles. Logs (leadership changes, notes, disciplinary actions, bonus points) are
-- insert-only; nothing here is deleted except a department's member list entries.

CREATE TABLE "wf_companies" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL,
  "name" VARCHAR(120) NOT NULL, "code" VARCHAR(30) NOT NULL, "is_headquarters" BOOLEAN NOT NULL DEFAULT false,
  "address" VARCHAR(200), "lga" VARCHAR(80), "state" VARCHAR(80), "country" VARCHAR(80) NOT NULL DEFAULT 'Nigeria',
  "version" INTEGER NOT NULL DEFAULT 1, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_companies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_companies_org_id_key" UNIQUE ("organization_id", "id")
);
CREATE UNIQUE INDEX "wf_companies_organization_id_code_key" ON "wf_companies"("organization_id", "code");
CREATE UNIQUE INDEX "wf_companies_one_hq_key" ON "wf_companies"("organization_id") WHERE "is_headquarters";

CREATE TABLE "wf_employees" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "user_id" TEXT,
  "name" VARCHAR(160) NOT NULL, "role" VARCHAR(80) NOT NULL, "cadre" VARCHAR(80) NOT NULL DEFAULT '',
  "phone" VARCHAR(30), "email" VARCHAR(160), "hire_date" DATE NOT NULL, "license" VARCHAR(60),
  "status" VARCHAR(8) NOT NULL DEFAULT 'ACTIVE',
  "dob" DATE, "gender" VARCHAR(6), "marital_status" VARCHAR(8), "address" VARCHAR(200), "lga" VARCHAR(80), "state" VARCHAR(80),
  "emergency_contact_name" VARCHAR(120), "emergency_contact_phone" VARCHAR(30), "emergency_contact_relation" VARCHAR(40),
  "qualification" VARCHAR(160),
  "company_id" TEXT, "department_id" TEXT, "job_position_id" TEXT, "job_role_id" TEXT, "employee_type_id" TEXT, "reporting_manager_id" TEXT,
  "date_joining" DATE, "contract_end_date" DATE, "work_email" VARCHAR(160), "work_phone" VARCHAR(30),
  "tag_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "bank_name" VARCHAR(80), "account_number" VARCHAR(20), "bank_branch" VARCHAR(80),
  "version" INTEGER NOT NULL DEFAULT 1, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_employees_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_employees_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_employees_company_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "wf_companies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_employees_manager_fkey" FOREIGN KEY ("organization_id", "reporting_manager_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_employees_values_check" CHECK (
    "status" IN ('ACTIVE', 'INACTIVE') AND ("gender" IS NULL OR "gender" IN ('Male', 'Female', 'Other')) AND
    ("marital_status" IS NULL OR "marital_status" IN ('Single', 'Married', 'Divorced', 'Widowed')) AND
    ("reporting_manager_id" IS NULL OR "reporting_manager_id" <> "id") AND ("account_number" IS NULL OR "account_number" ~ '^[0-9]{10}$')
  )
);
CREATE UNIQUE INDEX "wf_employees_organization_id_user_id_key" ON "wf_employees"("organization_id", "user_id") WHERE "user_id" IS NOT NULL;

CREATE TABLE "wf_departments" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL,
  "name" VARCHAR(120) NOT NULL, "code" VARCHAR(20) NOT NULL, "description" VARCHAR(500),
  "status" VARCHAR(10) NOT NULL DEFAULT 'Active', "parent_department_id" TEXT,
  "hod_employee_id" TEXT, "deputy_hod_employee_id" TEXT, "company_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "version" INTEGER NOT NULL DEFAULT 1, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_departments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_departments_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_departments_parent_fkey" FOREIGN KEY ("organization_id", "parent_department_id") REFERENCES "wf_departments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_departments_hod_fkey" FOREIGN KEY ("organization_id", "hod_employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_departments_deputy_fkey" FOREIGN KEY ("organization_id", "deputy_hod_employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_departments_values_check" CHECK ("status" IN ('Active', 'Inactive', 'Merging', 'Dissolved') AND ("parent_department_id" IS NULL OR "parent_department_id" <> "id"))
);
CREATE UNIQUE INDEX "wf_departments_organization_id_code_key" ON "wf_departments"("organization_id", "code");

CREATE TABLE "wf_department_members" (
  "organization_id" TEXT NOT NULL, "department_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL,
  "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_department_members_pkey" PRIMARY KEY ("organization_id", "department_id", "employee_id"),
  CONSTRAINT "wf_department_members_department_fkey" FOREIGN KEY ("organization_id", "department_id") REFERENCES "wf_departments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_department_members_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "wf_hod_changes" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "department_id" TEXT NOT NULL, "role" VARCHAR(10) NOT NULL,
  "previous_employee_id" TEXT, "new_employee_id" TEXT, "effective_date" DATE NOT NULL, "reason" VARCHAR(500),
  "changed_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_hod_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_hod_changes_department_fkey" FOREIGN KEY ("organization_id", "department_id") REFERENCES "wf_departments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_hod_changes_role_check" CHECK ("role" IN ('hod', 'deputy-hod'))
);

CREATE TABLE "wf_job_positions" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "name" VARCHAR(120) NOT NULL, "department_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_job_positions_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_job_positions_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_job_positions_department_fkey" FOREIGN KEY ("organization_id", "department_id") REFERENCES "wf_departments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "wf_job_roles" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "name" VARCHAR(120) NOT NULL, "job_position_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_job_roles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_job_roles_position_fkey" FOREIGN KEY ("organization_id", "job_position_id") REFERENCES "wf_job_positions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "wf_employee_types" ("id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "name" VARCHAR(80) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "wf_employee_types_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "wf_employee_types_organization_id_name_key" ON "wf_employee_types"("organization_id", "name");
CREATE TABLE "wf_tags" ("id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "name" VARCHAR(60) NOT NULL, "color" VARCHAR(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "wf_tags_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "wf_tags_organization_id_name_key" ON "wf_tags"("organization_id", "name");

CREATE TABLE "wf_employee_documents" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "title" VARCHAR(160) NOT NULL, "category" VARCHAR(80) NOT NULL,
  "status" VARCHAR(9) NOT NULL DEFAULT 'Requested', "issue_date" DATE, "expiry_date" DATE, "notify_before_days" INTEGER NOT NULL DEFAULT 30,
  "reject_reason" VARCHAR(500), "requested_by_user_id" TEXT NOT NULL, "reviewed_by_user_id" TEXT, "reviewed_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_employee_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_employee_documents_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_employee_documents_values_check" CHECK ("status" IN ('Requested', 'Uploaded', 'Approved', 'Rejected') AND "notify_before_days" BETWEEN 0 AND 365 AND ("status" <> 'Rejected' OR "reject_reason" IS NOT NULL))
);

CREATE TABLE "wf_action_types" ("id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "name" VARCHAR(80) NOT NULL, "block_option" BOOLEAN NOT NULL DEFAULT false, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "wf_action_types_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_action_types_org_id_key" UNIQUE ("organization_id", "id"));
CREATE UNIQUE INDEX "wf_action_types_organization_id_name_key" ON "wf_action_types"("organization_id", "name");
CREATE TABLE "wf_disciplinary_actions" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_ids" TEXT[] NOT NULL, "action_type_id" TEXT NOT NULL, "description" VARCHAR(2000) NOT NULL,
  "unit" VARCHAR(5) NOT NULL, "amount" INTEGER NOT NULL, "start_date" DATE NOT NULL, "attachment" VARCHAR(200), "recorded_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_disciplinary_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_disciplinary_actions_type_fkey" FOREIGN KEY ("organization_id", "action_type_id") REFERENCES "wf_action_types"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_disciplinary_actions_values_check" CHECK ("unit" IN ('Days', 'Hours') AND "amount" BETWEEN 0 AND 3650 AND cardinality("employee_ids") BETWEEN 1 AND 100)
);
CREATE TABLE "wf_employee_notes" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "note" VARCHAR(4000) NOT NULL, "by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_employee_notes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_employee_notes_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "wf_bonus_entries" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "delta" INTEGER NOT NULL, "reason" VARCHAR(500) NOT NULL, "by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_bonus_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_bonus_entries_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_bonus_entries_delta_check" CHECK ("delta" <> 0 AND "delta" BETWEEN -10000 AND 10000)
);
CREATE TABLE "wf_qualifications" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "title" VARCHAR(160) NOT NULL, "issuing_body" VARCHAR(160) NOT NULL,
  "date_obtained" DATE NOT NULL, "certificate_ref" VARCHAR(80), "recorded_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_qualifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_qualifications_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "wf_policies" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "category" VARCHAR(30) NOT NULL, "title" VARCHAR(160) NOT NULL, "purpose" VARCHAR(500) NOT NULL, "body" VARCHAR(20000) NOT NULL,
  "published_by_user_id" TEXT NOT NULL, "version" INTEGER NOT NULL DEFAULT 1, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_policies_category_check" CHECK ("category" IN ('Conduct', 'Safety & Clinical', 'Data & Security', 'IT & Assets', 'Leave & Attendance', 'Other'))
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['wf_companies', 'wf_employees', 'wf_departments', 'wf_department_members', 'wf_hod_changes', 'wf_job_positions', 'wf_job_roles', 'wf_employee_types', 'wf_tags',
    'wf_employee_documents', 'wf_action_types', 'wf_disciplinary_actions', 'wf_employee_notes', 'wf_bonus_entries', 'wf_qualifications', 'wf_policies'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sabi_emr_app', t);
  END LOOP;
END $$;
GRANT UPDATE ("name", "code", "address", "lga", "state", "country", "version") ON "wf_companies" TO sabi_emr_app;
GRANT UPDATE ("user_id", "name", "role", "cadre", "phone", "email", "license", "status", "dob", "gender", "marital_status", "address", "lga", "state",
  "emergency_contact_name", "emergency_contact_phone", "emergency_contact_relation", "qualification", "company_id", "department_id", "job_position_id", "job_role_id",
  "employee_type_id", "reporting_manager_id", "date_joining", "contract_end_date", "work_email", "work_phone", "tag_ids", "bank_name", "account_number", "bank_branch",
  "version", "updated_at") ON "wf_employees" TO sabi_emr_app;
GRANT UPDATE ("name", "code", "description", "status", "parent_department_id", "hod_employee_id", "deputy_hod_employee_id", "company_ids", "version") ON "wf_departments" TO sabi_emr_app;
GRANT DELETE ON "wf_department_members" TO sabi_emr_app;
GRANT UPDATE ("status", "issue_date", "expiry_date", "reject_reason", "reviewed_by_user_id", "reviewed_at", "version") ON "wf_employee_documents" TO sabi_emr_app;
GRANT UPDATE ("category", "title", "purpose", "body", "version", "updated_at") ON "wf_policies" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('hr.read', 'View employees, the organization structure and HR records'),
  ('hr.manage', 'Manage employees, organization structure, documents, notes and disciplinary records'),
  ('hr.sensitive', 'View and edit employees'' bank details and personal data')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('HR_OFFICER', 'hr.read'), ('HR_OFFICER', 'hr.manage'), ('HR_OFFICER', 'hr.sensitive'),
  ('HOSPITAL_ADMIN', 'hr.read'), ('HOSPITAL_ADMIN', 'hr.manage'),
  ('ORGANISATION_OWNER', 'hr.read'), ('ORGANISATION_OWNER', 'hr.manage'), ('ORGANISATION_OWNER', 'hr.sensitive')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
