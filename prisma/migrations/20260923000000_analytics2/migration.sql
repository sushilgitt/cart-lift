-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "timezone" TEXT;

-- AlterTable
ALTER TABLE "DailyStat" ADD COLUMN     "cost" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "eligibleOrders" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "subscribedOrders" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "DealOrder" ADD COLUMN     "bundle" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "StatFact" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "arm" TEXT NOT NULL DEFAULT 'A',
    "dim" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "addToCarts" INTEGER NOT NULL DEFAULT 0,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "units" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "addedRevenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cost" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "StatFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantCost" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "cost" DECIMAL(14,2),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariantCost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StatFact_shopId_day_idx" ON "StatFact"("shopId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "StatFact_dealId_arm_dim_key_day_key" ON "StatFact"("dealId", "arm", "dim", "key", "day");

-- CreateIndex
CREATE UNIQUE INDEX "VariantCost_shopId_variantId_key" ON "VariantCost"("shopId", "variantId");

-- AddForeignKey
ALTER TABLE "StatFact" ADD CONSTRAINT "StatFact_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatFact" ADD CONSTRAINT "StatFact_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantCost" ADD CONSTRAINT "VariantCost_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

