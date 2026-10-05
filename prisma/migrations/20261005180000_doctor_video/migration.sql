CREATE TABLE "doctor_video_rooms" (
  "appointment_id" TEXT NOT NULL PRIMARY KEY,
  "room_name" VARCHAR(64) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "cleanup_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "doctor_video_rooms_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "doctor_appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "doctor_video_rooms_room_name_key" ON "doctor_video_rooms"("room_name");
CREATE INDEX "doctor_video_rooms_revoked_at_cleanup_after_idx" ON "doctor_video_rooms"("revoked_at", "cleanup_after");
