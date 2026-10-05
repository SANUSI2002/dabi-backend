CREATE TABLE "DoctorApplication" (
 "id" TEXT PRIMARY KEY, "professionalId" TEXT NOT NULL UNIQUE,
 "details" JSONB NOT NULL, "consentVersion" TEXT NOT NULL,
 "consentAcceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "submittedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("professionalId") REFERENCES "professional_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "DoctorCredential" (
 "id" TEXT PRIMARY KEY, "applicationId" TEXT NOT NULL, "kind" TEXT NOT NULL,
 "storageKey" TEXT NOT NULL UNIQUE, "storageBucket" TEXT NOT NULL DEFAULT 'sabi-hospital-evidence-quarantine', "contentType" TEXT NOT NULL, "byteSize" INTEGER NOT NULL,
 "sha256" TEXT NOT NULL, "scanStatus" TEXT NOT NULL DEFAULT 'PENDING', "reviewStatus" TEXT NOT NULL DEFAULT 'PENDING',
 "scanAttempts" INTEGER NOT NULL DEFAULT 0, "scanLeaseToken" TEXT, "scanLeaseExpiresAt" TIMESTAMP(3), "scanErrorCode" TEXT, "scannerVersion" TEXT, "scannedAt" TIMESTAMP(3),
 "sourceName" TEXT, "reference" TEXT, "note" TEXT, "reviewedBy" TEXT, "reviewedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("applicationId") REFERENCES "DoctorApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "DoctorCredential_applicationId_kind_createdAt_idx" ON "DoctorCredential"("applicationId", "kind", "createdAt");
CREATE INDEX "DoctorCredential_scanStatus_scanLeaseExpiresAt_idx" ON "DoctorCredential"("scanStatus", "scanLeaseExpiresAt");
