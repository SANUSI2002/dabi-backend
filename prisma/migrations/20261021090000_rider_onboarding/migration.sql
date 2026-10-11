CREATE TABLE "rider_applications" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE RESTRICT,
  "fullName" VARCHAR(160) NOT NULL, "phone" VARCHAR(30) NOT NULL,
  "state" VARCHAR(100) NOT NULL, "city" VARCHAR(100) NOT NULL,
  "vehicleType" VARCHAR(20) NOT NULL CHECK ("vehicleType" IN ('MOTORCYCLE','CAR')),
  "licenceExpiresAt" DATE NOT NULL, "insuranceExpiresAt" DATE NOT NULL,
  "consentVersion" VARCHAR(60) NOT NULL, "consentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" VARCHAR(30) NOT NULL DEFAULT 'DRAFT' CHECK ("status" IN ('DRAFT','SUBMITTED','CHANGES_REQUESTED','APPROVED','REJECTED','SUSPENDED')),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "submittedAt" TIMESTAMP(3), "decidedAt" TIMESTAMP(3), "decidedBy" TEXT,
  "decisionReason" VARCHAR(1000),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "rider_applications_status_createdAt_id_idx" ON "rider_applications"("status","createdAt","id");
CREATE TABLE "rider_credentials" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "applicationId" TEXT NOT NULL REFERENCES "rider_applications"("id") ON DELETE RESTRICT,
  "kind" VARCHAR(40) NOT NULL CHECK ("kind" IN ('drivingLicence','vehicleRegistration','insurance')),
  "revision" INTEGER NOT NULL CHECK ("revision" > 0),
  "storageKey" TEXT NOT NULL UNIQUE, "storageBucket" TEXT NOT NULL, "contentType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL CHECK ("byteSize" > 0 AND "byteSize" <= 5242880), "sha256" VARCHAR(64) NOT NULL,
  "scanStatus" VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK ("scanStatus" IN ('PENDING','CLEAN','INFECTED','REJECTED','FAILED')),
  "scanAttempts" INTEGER NOT NULL DEFAULT 0 CHECK ("scanAttempts" >= 0), "scanLeaseToken" TEXT,
  "scanLeaseExpiresAt" TIMESTAMP(3), "scanErrorCode" TEXT, "scannerVersion" TEXT, "scannedAt" TIMESTAMP(3),
  "reviewStatus" VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK ("reviewStatus" IN ('PENDING','VERIFIED','REJECTED')),
  "sourceName" VARCHAR(200), "reference" VARCHAR(200), "note" VARCHAR(1000), "reviewedBy" TEXT, "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("applicationId","revision")
);
CREATE INDEX "rider_credentials_applicationId_kind_createdAt_id_idx" ON "rider_credentials"("applicationId","kind","createdAt","id");
CREATE INDEX "rider_credentials_scanStatus_scanLeaseExpiresAt_idx" ON "rider_credentials"("scanStatus","scanLeaseExpiresAt");
CREATE TABLE "rider_mail_jobs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "applicationId" TEXT NOT NULL REFERENCES "rider_applications"("id") ON DELETE RESTRICT,
  "kind" VARCHAR(30) NOT NULL CHECK ("kind" IN ('SUBMITTED','APPROVED','REJECTED','CHANGES_REQUESTED','SUSPENDED')),
  "version" INTEGER NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','SENT','FAILED','CANCELLED')),
  "attempts" INTEGER NOT NULL DEFAULT 0, "leaseToken" TEXT, "leaseExpiresAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("applicationId","kind","version")
);
CREATE INDEX "rider_mail_jobs_status_nextAttemptAt_idx" ON "rider_mail_jobs"("status","nextAttemptAt");
