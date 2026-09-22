-- AlterTable
ALTER TABLE "DailyStat" ADD COLUMN     "checkouts" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "DealCheckout" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealCheckout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DealCheckout_shopId_createdAt_idx" ON "DealCheckout"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DealCheckout_shopId_token_dealId_key" ON "DealCheckout"("shopId", "token", "dealId");

-- AddForeignKey
ALTER TABLE "DealCheckout" ADD CONSTRAINT "DealCheckout_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealCheckout" ADD CONSTRAINT "DealCheckout_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

