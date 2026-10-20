ALTER TABLE "HeatingState" ADD COLUMN "areaSetpoints" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "HeatingState" ADD COLUMN "boostUntil" TIMESTAMP(3);
