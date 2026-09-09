-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('DISABLED', 'PENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "Notification"
ADD COLUMN "emailStatus" "EmailDeliveryStatus" NOT NULL DEFAULT 'DISABLED',
ADD COLUMN "emailAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "emailProviderId" TEXT,
ADD COLUMN "emailLastError" TEXT,
ADD COLUMN "emailSentAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Notification_emailStatus_createdAt_idx" ON "Notification"("emailStatus", "createdAt");
