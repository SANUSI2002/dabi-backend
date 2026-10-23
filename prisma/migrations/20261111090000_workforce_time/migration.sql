-- Workforce, part 2: time & attendance and work. Scheduling (time blocks, weekly/rotational schedules,
-- assignments), attendance (clock in/out with breaks, one open interval per employee, server-computed
-- flags), overtime, timesheet periods and timesheets (lines derived from attendance while open and
-- frozen on submission; a version and an event log per submission; periods lock approved sheets;
-- amendments after lock are addenda), time policies and rules, holidays, leave and holiday-work
-- requests, and work containers/tasks/activities. Decisions are never made on one's own requests.

CREATE TABLE "wf_time_blocks" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "name" VARCHAR(80) NOT NULL, "code" VARCHAR(12) NOT NULL,
  "start_time" VARCHAR(5) NOT NULL, "end_time" VARCHAR(5) NOT NULL, "overnight" BOOLEAN NOT NULL DEFAULT false, "paid_hours" DECIMAL(5,2) NOT NULL,
  "break_mins" INTEGER NOT NULL DEFAULT 0, "late_grace_mins" INTEGER NOT NULL DEFAULT 0, "classification" VARCHAR(10) NOT NULL, "colour" VARCHAR(20) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_time_blocks_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_time_blocks_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_time_blocks_values_check" CHECK ("start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "paid_hours" BETWEEN 0 AND 24 AND "break_mins" BETWEEN 0 AND 600 AND "late_grace_mins" BETWEEN 0 AND 240 AND "classification" IN ('Working', 'Off', 'On-call', 'Flexible'))
);
CREATE UNIQUE INDEX "wf_time_blocks_organization_id_code_key" ON "wf_time_blocks"("organization_id", "code");

CREATE TABLE "wf_schedules" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "name" VARCHAR(120) NOT NULL, "description" VARCHAR(500), "start_date" DATE NOT NULL, "end_date" DATE,
  "days" JSONB NOT NULL, "rotation" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "rotation_anchor" DATE, "holiday_rule" VARCHAR(30) NOT NULL, "expected_cycle_hours" DECIMAL(6,2) NOT NULL,
  "status" VARCHAR(7) NOT NULL DEFAULT 'Draft', "version" INTEGER NOT NULL DEFAULT 1, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_schedules_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_schedules_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_schedules_values_check" CHECK ("status" IN ('Active', 'Draft', 'Retired') AND "holiday_rule" IN ('Observe as non-working', 'Preserve planned shift') AND ("end_date" IS NULL OR "end_date" >= "start_date") AND jsonb_typeof("days") = 'object')
);

CREATE TABLE "wf_schedule_assignments" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "schedule_id" TEXT NOT NULL, "effective_from" DATE NOT NULL, "effective_to" DATE,
  "capture_mode" VARCHAR(10) NOT NULL, "assigned_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_schedule_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_schedule_assignments_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_schedule_assignments_schedule_fkey" FOREIGN KEY ("organization_id", "schedule_id") REFERENCES "wf_schedules"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_schedule_assignments_values_check" CHECK ("capture_mode" IN ('Attendance', 'Manual', 'Hybrid') AND ("effective_to" IS NULL OR "effective_to" >= "effective_from"))
);

CREATE TABLE "wf_attendance" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "clock_in_at" TIMESTAMP(3) NOT NULL, "clock_out_at" TIMESTAMP(3),
  "source" VARCHAR(6) NOT NULL, "break_mins" INTEGER NOT NULL DEFAULT 0, "on_break_since" TIMESTAMP(3), "flags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "location" VARCHAR(120), "work_location" VARCHAR(12) NOT NULL DEFAULT 'WFO', "consent_at" TIMESTAMP(3),
  "resolution_action" VARCHAR(12), "resolution_by_user_id" TEXT, "resolution_at" TIMESTAMP(3), "resolution_note" VARCHAR(500),
  "recorded_by_user_id" TEXT NOT NULL, "version" INTEGER NOT NULL DEFAULT 1, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_attendance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_attendance_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_attendance_values_check" CHECK (
    "source" IN ('Web', 'Mobile', 'Kiosk', 'Manual') AND "work_location" IN ('WFO', 'WFH', 'Client Site') AND "break_mins" BETWEEN 0 AND 1440 AND
    ("clock_out_at" IS NULL OR "clock_out_at" > "clock_in_at") AND ("resolution_action" IS NULL OR "resolution_action" IN ('Acknowledged', 'Corrected', 'Excused', 'Escalated'))
  )
);
CREATE UNIQUE INDEX "wf_attendance_one_open_key" ON "wf_attendance"("organization_id", "employee_id") WHERE "clock_out_at" IS NULL;
CREATE INDEX "wf_attendance_clock_in_idx" ON "wf_attendance"("organization_id", "clock_in_at");

CREATE TABLE "wf_overtime_requests" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "work_date" DATE NOT NULL, "hours" DECIMAL(5,2) NOT NULL, "reason" VARCHAR(500) NOT NULL,
  "status" VARCHAR(8) NOT NULL DEFAULT 'Pending', "requested_by_user_id" TEXT NOT NULL, "decided_by_user_id" TEXT, "decided_at" TIMESTAMP(3), "decision_note" VARCHAR(500),
  "version" INTEGER NOT NULL DEFAULT 1, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_overtime_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_overtime_requests_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_overtime_requests_values_check" CHECK ("hours" > 0 AND "hours" <= 24 AND "status" IN ('Pending', 'Approved', 'Rejected'))
);

CREATE TABLE "wf_periods" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "label" VARCHAR(40) NOT NULL, "start_date" DATE NOT NULL, "end_date" DATE NOT NULL,
  "locked" BOOLEAN NOT NULL DEFAULT false, "locked_by_user_id" TEXT, "locked_at" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 1, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_periods_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_periods_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_periods_values_check" CHECK ("end_date" >= "start_date" AND ("locked" = false OR ("locked_by_user_id" IS NOT NULL AND "locked_at" IS NOT NULL)))
);
CREATE UNIQUE INDEX "wf_periods_organization_id_start_key" ON "wf_periods"("organization_id", "start_date");

CREATE TABLE "wf_timesheets" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "period_id" TEXT NOT NULL, "status" VARCHAR(9) NOT NULL DEFAULT 'Open',
  "capture_mode" VARCHAR(10) NOT NULL DEFAULT 'Attendance', "submission" INTEGER NOT NULL DEFAULT 0, "submitted_at" TIMESTAMP(3), "approved_at" TIMESTAMP(3),
  "approver_user_id" TEXT, "return_note" VARCHAR(500), "version" INTEGER NOT NULL DEFAULT 1, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_timesheets_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_timesheets_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_timesheets_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_timesheets_period_fkey" FOREIGN KEY ("organization_id", "period_id") REFERENCES "wf_periods"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_timesheets_values_check" CHECK ("status" IN ('Open', 'Submitted', 'Returned', 'Approved', 'Locked', 'Rejected') AND "capture_mode" IN ('Attendance', 'Manual', 'Hybrid'))
);
CREATE UNIQUE INDEX "wf_timesheets_employee_period_key" ON "wf_timesheets"("organization_id", "employee_id", "period_id");

CREATE TABLE "wf_timesheet_lines" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "timesheet_id" TEXT NOT NULL, "work_date" DATE NOT NULL, "source" VARCHAR(10) NOT NULL,
  "expected_hours" DECIMAL(5,2) NOT NULL DEFAULT 0, "worked_hours" DECIMAL(5,2) NOT NULL DEFAULT 0, "break_hours" DECIMAL(5,2) NOT NULL DEFAULT 0, "overtime_hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "container" VARCHAR(120), "task" VARCHAR(120), "note" VARCHAR(500), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_timesheet_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_timesheet_lines_timesheet_fkey" FOREIGN KEY ("organization_id", "timesheet_id") REFERENCES "wf_timesheets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_timesheet_lines_values_check" CHECK ("source" IN ('Attendance', 'Manual') AND "worked_hours" BETWEEN 0 AND 24 AND "overtime_hours" BETWEEN 0 AND 24 AND "expected_hours" BETWEEN 0 AND 24 AND "break_hours" BETWEEN 0 AND 24)
);

CREATE TABLE "wf_timesheet_events" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "timesheet_id" TEXT NOT NULL, "submission" INTEGER NOT NULL, "status" VARCHAR(9) NOT NULL,
  "by_user_id" TEXT NOT NULL, "note" VARCHAR(500), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_timesheet_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_timesheet_events_timesheet_fkey" FOREIGN KEY ("organization_id", "timesheet_id") REFERENCES "wf_timesheets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "wf_amendments" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "timesheet_id" TEXT NOT NULL, "reason" VARCHAR(500) NOT NULL, "change" VARCHAR(1000) NOT NULL,
  "status" VARCHAR(8) NOT NULL DEFAULT 'Pending', "requested_by_user_id" TEXT NOT NULL, "decided_by_user_id" TEXT, "decided_at" TIMESTAMP(3), "decision_note" VARCHAR(500),
  "version" INTEGER NOT NULL DEFAULT 1, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_amendments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_amendments_timesheet_fkey" FOREIGN KEY ("organization_id", "timesheet_id") REFERENCES "wf_timesheets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_amendments_status_check" CHECK ("status" IN ('Pending', 'Approved', 'Rejected'))
);

CREATE TABLE "wf_time_policies" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "scope" VARCHAR(120) NOT NULL, "effective_from" DATE NOT NULL, "effective_to" DATE,
  "period_type" VARCHAR(9) NOT NULL, "capture_default" VARCHAR(10) NOT NULL, "increment_mins" INTEGER NOT NULL, "rounding" VARCHAR(10) NOT NULL,
  "submission_deadline_days" INTEGER NOT NULL, "approval_deadline_days" INTEGER NOT NULL, "late_grace_mins" INTEGER NOT NULL, "early_leave_grace_mins" INTEGER NOT NULL,
  "absence_threshold_mins" INTEGER NOT NULL, "max_daily_hours" INTEGER NOT NULL, "allow_edit_derived" BOOLEAN NOT NULL, "overtime_enabled" BOOLEAN NOT NULL,
  "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_time_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_time_policies_values_check" CHECK ("period_type" IN ('Weekly', 'Bi-weekly', 'Monthly') AND "capture_default" IN ('Attendance', 'Manual', 'Hybrid') AND "rounding" IN ('None', 'Nearest 5', 'Nearest 15') AND "max_daily_hours" BETWEEN 1 AND 24 AND ("effective_to" IS NULL OR "effective_to" >= "effective_from"))
);

CREATE TABLE "wf_settings" (
  "organization_id" TEXT NOT NULL, "capabilities" JSONB NOT NULL, "break_rules" JSONB NOT NULL, "attendance_rules" JSONB NOT NULL, "enrolments" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1, "updated_by_user_id" TEXT, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_settings_pkey" PRIMARY KEY ("organization_id")
);

CREATE TABLE "wf_holidays" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "name" VARCHAR(120) NOT NULL, "holiday_date" DATE NOT NULL, "scope" VARCHAR(12) NOT NULL, "scope_value" VARCHAR(120) NOT NULL,
  "paid" BOOLEAN NOT NULL DEFAULT true, "work_requires_approval" BOOLEAN NOT NULL DEFAULT true, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_holidays_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_holidays_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_holidays_scope_check" CHECK ("scope" IN ('Organisation', 'Location', 'Group', 'Schedule'))
);

CREATE TABLE "wf_leave_requests" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "leave_type" VARCHAR(60) NOT NULL, "from_date" DATE NOT NULL, "to_date" DATE NOT NULL,
  "days" DECIMAL(5,1) NOT NULL, "paid" BOOLEAN NOT NULL DEFAULT true, "note" VARCHAR(500), "status" VARCHAR(8) NOT NULL DEFAULT 'Pending',
  "requested_by_user_id" TEXT NOT NULL, "decided_by_user_id" TEXT, "decided_at" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 1, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_leave_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_leave_requests_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_leave_requests_values_check" CHECK ("to_date" >= "from_date" AND "days" > 0 AND "status" IN ('Pending', 'Approved', 'Rejected'))
);

CREATE TABLE "wf_holiday_work_requests" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "employee_id" TEXT NOT NULL, "holiday_id" TEXT NOT NULL, "reason" VARCHAR(500) NOT NULL, "hours" DECIMAL(5,2) NOT NULL,
  "status" VARCHAR(8) NOT NULL DEFAULT 'Pending', "requested_by_user_id" TEXT NOT NULL, "decided_by_user_id" TEXT, "decided_at" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 1, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_holiday_work_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_holiday_work_requests_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_holiday_work_requests_holiday_fkey" FOREIGN KEY ("organization_id", "holiday_id") REFERENCES "wf_holidays"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_holiday_work_requests_values_check" CHECK ("hours" > 0 AND "hours" <= 24 AND "status" IN ('Pending', 'Approved', 'Rejected'))
);

CREATE TABLE "wf_work_containers" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "label" VARCHAR(40) NOT NULL, "name" VARCHAR(120) NOT NULL, "code" VARCHAR(20) NOT NULL, "owner" VARCHAR(120) NOT NULL,
  "status" VARCHAR(6) NOT NULL DEFAULT 'Active', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_work_containers_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_work_containers_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_work_containers_status_check" CHECK ("status" IN ('Active', 'Closed'))
);
CREATE UNIQUE INDEX "wf_work_containers_organization_id_code_key" ON "wf_work_containers"("organization_id", "code");
CREATE TABLE "wf_work_tasks" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "container_id" TEXT NOT NULL, "name" VARCHAR(160) NOT NULL, "parent_id" TEXT, "assigned_to" VARCHAR(120) NOT NULL,
  "status" VARCHAR(11) NOT NULL DEFAULT 'Not started', "estimate_hours" DECIMAL(7,2) NOT NULL DEFAULT 0, "version" INTEGER NOT NULL DEFAULT 1, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_work_tasks_pkey" PRIMARY KEY ("id"), CONSTRAINT "wf_work_tasks_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "wf_work_tasks_container_fkey" FOREIGN KEY ("organization_id", "container_id") REFERENCES "wf_work_containers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_work_tasks_values_check" CHECK ("status" IN ('Not started', 'In progress', 'Blocked', 'Done') AND "estimate_hours" >= 0)
);
CREATE TABLE "wf_work_activities" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "task_id" TEXT NOT NULL, "staff" VARCHAR(120) NOT NULL, "work_date" DATE NOT NULL, "hours" DECIMAL(5,2) NOT NULL,
  "note" VARCHAR(500) NOT NULL DEFAULT '', "logged_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wf_work_activities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wf_work_activities_task_fkey" FOREIGN KEY ("organization_id", "task_id") REFERENCES "wf_work_tasks"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wf_work_activities_hours_check" CHECK ("hours" > 0 AND "hours" <= 24)
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['wf_time_blocks', 'wf_schedules', 'wf_schedule_assignments', 'wf_attendance', 'wf_overtime_requests', 'wf_periods', 'wf_timesheets', 'wf_timesheet_lines',
    'wf_timesheet_events', 'wf_amendments', 'wf_time_policies', 'wf_settings', 'wf_holidays', 'wf_leave_requests', 'wf_holiday_work_requests', 'wf_work_containers', 'wf_work_tasks', 'wf_work_activities'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sabi_emr_app', t);
  END LOOP;
END $$;
GRANT UPDATE ("active") ON "wf_time_blocks" TO sabi_emr_app;
GRANT UPDATE ("status", "end_date", "version") ON "wf_schedules" TO sabi_emr_app;
GRANT UPDATE ("effective_to") ON "wf_schedule_assignments" TO sabi_emr_app;
GRANT UPDATE ("clock_in_at", "clock_out_at", "break_mins", "on_break_since", "flags", "resolution_action", "resolution_by_user_id", "resolution_at", "resolution_note", "version") ON "wf_attendance" TO sabi_emr_app;
GRANT UPDATE ("status", "decided_by_user_id", "decided_at", "decision_note", "version") ON "wf_overtime_requests", "wf_amendments" TO sabi_emr_app;
GRANT UPDATE ("locked", "locked_by_user_id", "locked_at", "version") ON "wf_periods" TO sabi_emr_app;
GRANT UPDATE ("status", "submission", "submitted_at", "approved_at", "approver_user_id", "return_note", "version") ON "wf_timesheets" TO sabi_emr_app;
GRANT UPDATE ("overtime_hours") ON "wf_timesheet_lines" TO sabi_emr_app;
GRANT DELETE ON "wf_timesheet_lines" TO sabi_emr_app;
GRANT UPDATE ("capabilities", "break_rules", "attendance_rules", "enrolments", "version", "updated_by_user_id", "updated_at") ON "wf_settings" TO sabi_emr_app;
GRANT UPDATE ("status", "decided_by_user_id", "decided_at", "version") ON "wf_leave_requests", "wf_holiday_work_requests" TO sabi_emr_app;
GRANT UPDATE ("status") ON "wf_work_containers" TO sabi_emr_app;
GRANT UPDATE ("status", "version") ON "wf_work_tasks" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('workforce.self', 'Record your own time: clock in/out, breaks, timesheets, leave and overtime requests'),
  ('workforce.approve', 'Approve timesheets, leave, overtime, amendments and resolve attendance exceptions'),
  ('workforce.manage', 'Configure time & attendance: time blocks, schedules, assignments, policies, holidays, periods, work'),
  ('workforce.directory', 'See colleagues'' names and roles (for schedules and rosters)')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code")
SELECT r.code, p.code FROM "access_roles" r CROSS JOIN (VALUES ('workforce.self'), ('workforce.directory')) AS p(code)
WHERE r.scope = 'ORGANIZATION'
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('HR_OFFICER', 'workforce.approve'), ('HR_OFFICER', 'workforce.manage'),
  ('HOSPITAL_ADMIN', 'workforce.approve'), ('HOSPITAL_ADMIN', 'workforce.manage'),
  ('ORGANISATION_OWNER', 'workforce.approve'), ('ORGANISATION_OWNER', 'workforce.manage')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
