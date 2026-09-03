CREATE TYPE "OrderPurpose" AS ENUM ('ENTRY', 'STOP_LOSS', 'TAKE_PROFIT');

ALTER TABLE "Order"
ADD COLUMN "stopLossPrice" DECIMAL(28,10),
ADD COLUMN "takeProfitPrice" DECIMAL(28,10),
ADD COLUMN "purpose" "OrderPurpose" NOT NULL DEFAULT 'ENTRY',
ADD COLUMN "reduceOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "parentOrderId" UUID,
ADD COLUMN "ocoGroupId" UUID,
ADD COLUMN "triggeredAt" TIMESTAMP(3);

CREATE INDEX "Order_accountId_status_idx" ON "Order"("accountId", "status");
CREATE INDEX "Order_parentOrderId_idx" ON "Order"("parentOrderId");
CREATE INDEX "Order_ocoGroupId_idx" ON "Order"("ocoGroupId");

ALTER TABLE "Order"
ADD CONSTRAINT "Order_parentOrderId_fkey"
FOREIGN KEY ("parentOrderId") REFERENCES "Order"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
