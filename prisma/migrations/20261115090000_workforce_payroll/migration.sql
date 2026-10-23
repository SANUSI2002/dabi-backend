-- Workforce, part 6: payroll records. Salary structures, payslip batches (Draft → Review Ongoing →
-- Confirmed → Paid; whoever generated a batch does not confirm it), contracts, staff loans with their
-- repayments and overdue letters, loan eligibility tiers, and reimbursements. This keeps the records
-- only: "Paid" records that payment was made outside Sabi — nothing here moves money or sends mail.
-- Salary data is its own permission (payroll.read / payroll.manage), separate from general HR access.

CREATE TABLE "wf_salary_structures" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "basic_salary" DECIMAL(14,2) NOT NULL,
  "allowances" JSONB NOT NULL DEFAULT '[]', "deductions" JSONB NOT NULL DEFAULT '[]', "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_by_user_id" TEXT NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "wf_salary_structures_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_salary_structures_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_salary_structures_values_check" CHECK ("basic_salary" >= 0 AND jsonb_typeof("allowances") = 'array' AND jsonb_typeof("deductions") = 'array')
);
CREATE UNIQUE INDEX "wf_salary_structures_employee_key" ON "wf_salary_structures"("organization_id", "employee_id");

CREATE TABLE "wf_payslips" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "batch" VARCHAR(80) NOT NULL, "start_date" DATE NOT NULL, "end_date" DATE NOT NULL,
  "basic_salary" DECIMAL(14,2) NOT NULL, "allowances" JSONB NOT NULL, "deductions" JSONB NOT NULL, "gross_pay" DECIMAL(14,2) NOT NULL,
  "total_deductions" DECIMAL(14,2) NOT NULL, "net_pay" DECIMAL(14,2) NOT NULL, "loan_id" TEXT, "loan_deduction" DECIMAL(14,2),
  "status" VARCHAR(14) NOT NULL DEFAULT 'Draft', "generated_by_user_id" TEXT NOT NULL, "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmed_by_user_id" TEXT, "confirmed_at" TIMESTAMP(3), "paid_by_user_id" TEXT, "paid_at" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "wf_payslips_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_payslips_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_payslips_values_check" CHECK (
    "status" IN ('Draft', 'Review Ongoing', 'Confirmed', 'Paid') AND "end_date" >= "start_date" AND "gross_pay" >= 0 AND "total_deductions" >= 0 AND
    ("status" NOT IN ('Confirmed', 'Paid') OR ("confirmed_by_user_id" IS NOT NULL AND "confirmed_by_user_id" <> "generated_by_user_id")) AND
    ("status" <> 'Paid' OR "paid_at" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "wf_payslips_batch_employee_key" ON "wf_payslips"("organization_id", "batch", "employee_id");

CREATE TABLE "wf_contracts" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "title" VARCHAR(160) NOT NULL, "start_date" DATE NOT NULL, "end_date" DATE,
  "basic_salary" DECIMAL(14,2) NOT NULL, "status" VARCHAR(10) NOT NULL DEFAULT 'Active', "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_contracts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_contracts_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_contracts_values_check" CHECK ("status" IN ('Active', 'Expired', 'Terminated') AND "basic_salary" >= 0 AND ("end_date" IS NULL OR "end_date" >= "start_date"))
);

CREATE TABLE "wf_loans" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "type" VARCHAR(60) NOT NULL, "amount" DECIMAL(14,2) NOT NULL,
  "installments" INTEGER NOT NULL, "installment_amount" DECIMAL(14,2) NOT NULL, "installments_paid" INTEGER NOT NULL DEFAULT 0, "reason" VARCHAR(1000) NOT NULL,
  "repayment_method" VARCHAR(17) NOT NULL, "status" VARCHAR(9) NOT NULL DEFAULT 'Requested', "current_period_due" DECIMAL(14,2) NOT NULL,
  "current_period_paid" DECIMAL(14,2) NOT NULL DEFAULT 0, "period_start_date" TIMESTAMP(3), "missed_periods" INTEGER NOT NULL DEFAULT 0,
  "total_paid" DECIMAL(14,2) NOT NULL DEFAULT 0, "requested_by_user_id" TEXT NOT NULL, "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_by_user_id" TEXT, "decided_at" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "wf_loans_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_loans_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_loans_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_loans_values_check" CHECK (
    "status" IN ('Requested', 'Rejected', 'Repaying', 'Overdue', 'Settled') AND "repayment_method" IN ('Manual', 'Salary Auto-Debit') AND
    "amount" > 0 AND "installments" BETWEEN 1 AND 120 AND "installments_paid" BETWEEN 0 AND "installments" AND "total_paid" >= 0 AND
    ("status" = 'Requested' OR "decided_by_user_id" IS NOT NULL)
  )
);
CREATE TABLE "wf_loan_payments" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "loan_id" TEXT NOT NULL, "amount" DECIMAL(14,2) NOT NULL, "paid_on" DATE NOT NULL, "payslip_id" TEXT,
  "recorded_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_loan_payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_loan_payments_loan_fkey" FOREIGN KEY ("organization_id", "loan_id") REFERENCES "wf_loans"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_loan_payments_amount_check" CHECK ("amount" > 0)
);
CREATE TABLE "wf_loan_letters" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "loan_id" TEXT NOT NULL, "level" INTEGER NOT NULL, "amount_owed" DECIMAL(14,2) NOT NULL,
  "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "sent" BOOLEAN NOT NULL DEFAULT false, "sent_at" TIMESTAMP(3), "sent_by_user_id" TEXT,
  CONSTRAINT "wf_loan_letters_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_loan_letters_loan_fkey" FOREIGN KEY ("organization_id", "loan_id") REFERENCES "wf_loans"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_loan_letters_values_check" CHECK ("level" IN (1, 2) AND ("sent" = ("sent_at" IS NOT NULL)))
);
CREATE TABLE "wf_loan_tiers" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "min_monthly_salary" DECIMAL(14,2) NOT NULL, "max_monthly_salary" DECIMAL(14,2), "max_loan_amount" DECIMAL(14,2) NOT NULL,
  CONSTRAINT "wf_loan_tiers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_loan_tiers_values_check" CHECK ("min_monthly_salary" >= 0 AND ("max_monthly_salary" IS NULL OR "max_monthly_salary" >= "min_monthly_salary") AND "max_loan_amount" > 0)
);
CREATE TABLE "wf_reimbursements" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "type" VARCHAR(20) NOT NULL, "title" VARCHAR(200) NOT NULL, "amount" DECIMAL(14,2) NOT NULL,
  "status" VARCHAR(9) NOT NULL DEFAULT 'Requested', "requested_by_user_id" TEXT NOT NULL, "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_by_user_id" TEXT, "decided_at" TIMESTAMP(3), "paid_at" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "wf_reimbursements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_reimbursements_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_reimbursements_values_check" CHECK ("type" IN ('Expense Claim', 'Leave Encashment') AND "status" IN ('Requested', 'Approved', 'Rejected', 'Paid') AND "amount" > 0)
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['wf_salary_structures', 'wf_payslips', 'wf_contracts', 'wf_loans', 'wf_loan_payments', 'wf_loan_letters', 'wf_loan_tiers', 'wf_reimbursements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sabi_emr_app', t);
  END LOOP;
END $$;
GRANT UPDATE ("basic_salary", "allowances", "deductions", "effective_from", "updated_by_user_id", "version") ON "wf_salary_structures" TO sabi_emr_app;
GRANT UPDATE ("status", "confirmed_by_user_id", "confirmed_at", "paid_by_user_id", "paid_at", "version") ON "wf_payslips" TO sabi_emr_app;
GRANT UPDATE ("installments_paid", "status", "current_period_due", "current_period_paid", "period_start_date", "missed_periods", "total_paid", "decided_by_user_id", "decided_at", "version") ON "wf_loans" TO sabi_emr_app;
GRANT UPDATE ("sent", "sent_at", "sent_by_user_id") ON "wf_loan_letters" TO sabi_emr_app;
GRANT UPDATE ("status", "decided_by_user_id", "decided_at", "paid_at", "version") ON "wf_reimbursements" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('payroll.read', 'See salary structures, payslips, contracts, staff loans and reimbursements'),
  ('payroll.manage', 'Set salaries, run and confirm payslips, decide loans and reimbursements, record repayments')
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('HR_OFFICER', 'payroll.read'), ('HR_OFFICER', 'payroll.manage'),
  ('FINANCE_OFFICER', 'payroll.read'), ('FINANCE_OFFICER', 'payroll.manage'),
  ('ORGANISATION_OWNER', 'payroll.read'), ('ORGANISATION_OWNER', 'payroll.manage')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
