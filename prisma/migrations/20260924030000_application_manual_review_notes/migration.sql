CREATE TABLE "platform_application_review_notes" (
  "id" TEXT NOT NULL,
  "application_id" TEXT NOT NULL,
  "reviewer_id" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_application_review_notes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_application_review_notes_note_check" CHECK (length(btrim("note")) BETWEEN 10 AND 2000)
);
CREATE INDEX "platform_application_review_notes_application_id_created_at_idx" ON "platform_application_review_notes"("application_id", "created_at");
ALTER TABLE "platform_application_review_notes" ADD CONSTRAINT "platform_application_review_notes_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "platform_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
