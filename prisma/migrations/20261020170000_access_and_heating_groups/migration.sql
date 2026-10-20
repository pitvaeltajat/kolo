-- Add control-group metadata without changing existing device state records.
ALTER TABLE "Device" ADD COLUMN "controlGroup" TEXT;

-- Enforce the one-active-key-per-person rule while retaining revoked key history.
CREATE UNIQUE INDEX "Tag_one_active_key_per_person" ON "Tag"("memberEmail") WHERE "active" = true;
