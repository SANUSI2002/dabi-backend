CREATE TABLE "ProfessionalSchedule" (
  "professionalId" TEXT PRIMARY KEY REFERENCES "professional_profiles"("id") ON DELETE CASCADE,
  "timezone" TEXT NOT NULL DEFAULT 'Africa/Lagos',
  "durationMinutes" INTEGER NOT NULL DEFAULT 30 CHECK ("durationMinutes" BETWEEN 5 AND 240),
  "bufferMinutes" INTEGER NOT NULL DEFAULT 5 CHECK ("bufferMinutes" BETWEEN 0 AND 120),
  "weeklyHours" JSONB NOT NULL DEFAULT '[]',
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "ProfessionalTimeBlock" (
  "id" TEXT PRIMARY KEY,
  "professionalId" TEXT NOT NULL REFERENCES "professional_profiles"("id") ON DELETE CASCADE,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "valid_block_range" CHECK ("endsAt" > "startsAt")
);
CREATE INDEX "ProfessionalTimeBlock_professionalId_startsAt_endsAt_idx" ON "ProfessionalTimeBlock"("professionalId", "startsAt", "endsAt");
