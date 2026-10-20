-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "memberEmail" TEXT NOT NULL,
    "memberName" TEXT,
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoorEvent" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "memberEmail" TEXT,
    "memberName" TEXT,
    "method" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "detail" TEXT,

    CONSTRAINT "DoorEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "room" TEXT,
    "state" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HeatingState" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "setpointC" DOUBLE PRECISION NOT NULL DEFAULT 12,
    "roomOffsets" JSONB NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL DEFAULT 'DEFAULT',
    "overrideUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HeatingState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeenNonce" (
    "nonce" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeenNonce_pkey" PRIMARY KEY ("nonce")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tag_uid_key" ON "Tag"("uid");

-- CreateIndex
CREATE INDEX "Tag_memberEmail_idx" ON "Tag"("memberEmail");

-- CreateIndex
CREATE INDEX "DoorEvent_at_idx" ON "DoorEvent"("at");

-- CreateIndex
CREATE INDEX "Device_kind_idx" ON "Device"("kind");

-- CreateIndex
CREATE INDEX "SeenNonce_at_idx" ON "SeenNonce"("at");
