ALTER TABLE "DoctorApplication" ADD COLUMN "stage" TEXT NOT NULL DEFAULT 'DRAFT';
UPDATE "DoctorApplication" a SET "stage" = CASE p.verification_status::text WHEN 'VERIFIED' THEN 'APPROVED' WHEN 'REJECTED' THEN 'REJECTED' ELSE CASE WHEN a."submittedAt" IS NOT NULL THEN 'PENDING_REVIEW' ELSE 'DRAFT' END END FROM professional_profiles p WHERE p.id = a."professionalId";
ALTER TABLE "DoctorApplication" ADD CONSTRAINT "professional_application_stage" CHECK ("stage" IN ('DRAFT', 'SUBMITTED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED'));
