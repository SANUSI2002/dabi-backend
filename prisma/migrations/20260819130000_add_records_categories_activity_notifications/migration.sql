-- AlterTable: cached "latest" health score on the profile (kept in sync with health_metrics)
ALTER TABLE "user_profiles" ADD COLUMN     "health_score" INTEGER NOT NULL DEFAULT 0;

-- Rename MedicalRecord -> medical_records, preserving data, and realign the
-- auto-generated constraint/index names with the new table name so Prisma does
-- not report drift on the next `migrate dev`.
ALTER TABLE "MedicalRecord" RENAME TO "medical_records";
ALTER TABLE "medical_records" RENAME CONSTRAINT "MedicalRecord_pkey" TO "medical_records_pkey";
ALTER TABLE "medical_records" RENAME CONSTRAINT "MedicalRecord_user_id_fkey" TO "medical_records_user_id_fkey";
ALTER INDEX "MedicalRecord_user_id_idx" RENAME TO "medical_records_user_id_idx";

-- AlterTable: facility becomes optional + new record fields
ALTER TABLE "medical_records" ALTER COLUMN "facility" DROP NOT NULL;
ALTER TABLE "medical_records"
    ADD COLUMN     "categoryId" TEXT,
    ADD COLUMN     "recordType" TEXT NOT NULL DEFAULT 'Physical',
    ADD COLUMN     "doctorName" TEXT,
    ADD COLUMN     "diagnosis" TEXT,
    ADD COLUMN     "treatment" TEXT,
    ADD COLUMN     "notes" TEXT,
    ADD COLUMN     "documentUrl" TEXT;

-- CreateTable
CREATE TABLE "record_categories" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "record_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "medical_records_categoryId_idx" ON "medical_records"("categoryId");

-- CreateIndex
CREATE INDEX "record_categories_user_id_idx" ON "record_categories"("user_id");

-- CreateIndex
CREATE INDEX "activity_logs_user_id_idx" ON "activity_logs"("user_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_idx" ON "notifications"("user_id");

-- AddForeignKey
ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "record_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_categories" ADD CONSTRAINT "record_categories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
