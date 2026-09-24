ALTER TABLE "platform_application_evidence"
  ADD COLUMN "unscanned_downloaded_by_user_id" TEXT,
  ADD COLUMN "unscanned_downloaded_at" TIMESTAMP(3),
  ADD COLUMN "unscanned_exception_by_user_id" TEXT,
  ADD COLUMN "unscanned_exception_at" TIMESTAMP(3),
  ADD COLUMN "unscanned_exception_note" TEXT;
