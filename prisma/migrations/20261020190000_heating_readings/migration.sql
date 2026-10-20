CREATE TABLE "HeatingReading" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "controlGroup" TEXT NOT NULL,
    "room" TEXT,
    "tempC" DOUBLE PRECISION NOT NULL,
    "targetC" DOUBLE PRECISION,
    CONSTRAINT "HeatingReading_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HeatingReading_controlGroup_at_idx" ON "HeatingReading"("controlGroup", "at");
