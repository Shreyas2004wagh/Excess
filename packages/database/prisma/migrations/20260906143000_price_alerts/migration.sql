CREATE TYPE "PriceAlertDirection" AS ENUM ('ABOVE', 'BELOW');
CREATE TYPE "PriceAlertStatus" AS ENUM ('ACTIVE', 'TRIGGERED', 'CANCELLED');

CREATE TABLE "PriceAlert" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "instrumentId" UUID NOT NULL,
    "direction" "PriceAlertDirection" NOT NULL,
    "targetPrice" DECIMAL(28,10) NOT NULL,
    "status" "PriceAlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "triggeredPrice" DECIMAL(28,10),
    "triggeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PriceAlert_userId_status_createdAt_idx"
ON "PriceAlert"("userId", "status", "createdAt");

CREATE INDEX "PriceAlert_instrumentId_status_targetPrice_idx"
ON "PriceAlert"("instrumentId", "status", "targetPrice");

ALTER TABLE "PriceAlert"
ADD CONSTRAINT "PriceAlert_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PriceAlert"
ADD CONSTRAINT "PriceAlert_instrumentId_fkey"
FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
