CREATE TYPE "UserRole" AS ENUM ('TRADER', 'ADMIN');

ALTER TYPE "OutboxStatus" ADD VALUE 'PROCESSING' BEFORE 'PUBLISHED';

ALTER TABLE "User"
ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'TRADER';

ALTER TABLE "OutboxEvent"
ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "claimedAt" TIMESTAMP(3),
ADD COLUMN "lastError" TEXT;

CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "outboxEventId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Notification_outboxEventId_key"
ON "Notification"("outboxEventId");

CREATE INDEX "Notification_userId_readAt_createdAt_idx"
ON "Notification"("userId", "readAt", "createdAt");

CREATE INDEX "Notification_userId_createdAt_idx"
ON "Notification"("userId", "createdAt");

CREATE INDEX "OutboxEvent_status_nextAttemptAt_createdAt_idx"
ON "OutboxEvent"("status", "nextAttemptAt", "createdAt");

ALTER TABLE "Notification"
ADD CONSTRAINT "Notification_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Notification"
ADD CONSTRAINT "Notification_outboxEventId_fkey"
FOREIGN KEY ("outboxEventId") REFERENCES "OutboxEvent"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
