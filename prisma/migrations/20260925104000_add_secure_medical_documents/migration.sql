CREATE TYPE "MedicalDocumentStatus" AS ENUM ('PENDING_UPLOAD', 'PENDING_SCAN', 'CLEAN', 'INFECTED', 'REJECTED', 'PENDING_CLINICAL_REVIEW', 'DELETED');
CREATE TYPE "MedicalDocumentKind" AS ENUM ('MEDICAL_RECORD', 'LAB_RESULT', 'IMAGING', 'EXTERNAL_PRESCRIPTION', 'OTHER');
CREATE TYPE "MedicalDocumentScanVerdict" AS ENUM ('CLEAN', 'INFECTED', 'REJECTED');

CREATE TABLE "medical_documents" (
  "id" TEXT NOT NULL,
  "owner_patient_id" TEXT NOT NULL,
  "medical_record_id" TEXT,
  "object_key" TEXT NOT NULL,
  "original_filename" VARCHAR(180) NOT NULL,
  "declared_content_type" VARCHAR(64) NOT NULL,
  "validated_content_type" VARCHAR(64),
  "byte_size" INTEGER NOT NULL,
  "kind" "MedicalDocumentKind" NOT NULL,
  "status" "MedicalDocumentStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
  "scan_verdict" "MedicalDocumentScanVerdict",
  "scan_requested_at" TIMESTAMP(3),
  "scanned_at" TIMESTAMP(3),
  "sha256" CHAR(64),
  "deleted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "medical_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "medical_document_shares" (
  "id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "recipient_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "medical_document_shares_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "medical_document_scan_results" (
  "id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "replay_digest" CHAR(64) NOT NULL,
  "verdict" "MedicalDocumentScanVerdict" NOT NULL,
  "validated_content_type" VARCHAR(64) NOT NULL,
  "byte_size" INTEGER NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "scanner_timestamp" TIMESTAMP(3) NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "medical_document_scan_results_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "medical_documents_object_key_key" ON "medical_documents"("object_key");
CREATE INDEX "medical_documents_owner_patient_id_status_created_at_idx" ON "medical_documents"("owner_patient_id", "status", "created_at");
CREATE INDEX "medical_documents_medical_record_id_idx" ON "medical_documents"("medical_record_id");
CREATE INDEX "medical_documents_status_scan_requested_at_idx" ON "medical_documents"("status", "scan_requested_at");
CREATE INDEX "medical_document_shares_document_id_revoked_at_idx" ON "medical_document_shares"("document_id", "revoked_at");
CREATE INDEX "medical_document_shares_recipient_id_revoked_at_expires_at_idx" ON "medical_document_shares"("recipient_id", "revoked_at", "expires_at");
CREATE UNIQUE INDEX "medical_document_scan_results_replay_digest_key" ON "medical_document_scan_results"("replay_digest");
CREATE INDEX "medical_document_scan_results_document_id_received_at_idx" ON "medical_document_scan_results"("document_id", "received_at");

ALTER TABLE "medical_documents" ADD CONSTRAINT "medical_documents_owner_patient_id_fkey" FOREIGN KEY ("owner_patient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "medical_documents" ADD CONSTRAINT "medical_documents_medical_record_id_fkey" FOREIGN KEY ("medical_record_id") REFERENCES "medical_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "medical_document_shares" ADD CONSTRAINT "medical_document_shares_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "medical_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "medical_document_shares" ADD CONSTRAINT "medical_document_shares_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "medical_document_scan_results" ADD CONSTRAINT "medical_document_scan_results_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "medical_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
