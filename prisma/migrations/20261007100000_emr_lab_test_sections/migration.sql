-- The laboratory section a test belongs to (Haematology, Clinical Chemistry, …): ordering screens
-- group tests by it. Tests created before this change are "General" until the lab edits them.
ALTER TABLE "emr_lab_tests" ADD COLUMN "section" TEXT NOT NULL DEFAULT 'General';
