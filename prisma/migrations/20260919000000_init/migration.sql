-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'STARTER', 'SCALE', 'PRO');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "DealType" AS ENUM ('QUANTITY_BREAK', 'BXGY', 'BUNDLE');

-- CreateEnum
CREATE TYPE "TargetType" AS ENUM ('ALL', 'PRODUCTS', 'COLLECTIONS', 'EXCEPT');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "currencyCode" TEXT,
    "moneyFormat" TEXT,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "discountId" TEXT,
    "pixelId" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "publishedHash" TEXT,
    "publishedAt" TIMESTAMP(3),
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DealType" NOT NULL DEFAULT 'QUANTITY_BREAK',
    "status" "DealStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "targetType" "TargetType" NOT NULL DEFAULT 'ALL',
    "products" JSONB NOT NULL DEFAULT '[]',
    "collections" JSONB NOT NULL DEFAULT '[]',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyStat" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "arm" TEXT NOT NULL DEFAULT 'A',
    "day" DATE NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "addToCarts" INTEGER NOT NULL DEFAULT 0,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "units" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "addedRevenue" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "DailyStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealOrder" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "arm" TEXT NOT NULL DEFAULT 'A',
    "orderId" TEXT NOT NULL,
    "currency" TEXT,
    "units" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "addedRevenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE INDEX "Deal_shopId_status_idx" ON "Deal"("shopId", "status");

-- CreateIndex
CREATE INDEX "DailyStat_shopId_day_idx" ON "DailyStat"("shopId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "DailyStat_dealId_arm_day_key" ON "DailyStat"("dealId", "arm", "day");

-- CreateIndex
CREATE INDEX "DealOrder_shopId_createdAt_idx" ON "DealOrder"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DealOrder_shopId_orderId_dealId_key" ON "DealOrder"("shopId", "orderId", "dealId");

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyStat" ADD CONSTRAINT "DailyStat_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyStat" ADD CONSTRAINT "DailyStat_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealOrder" ADD CONSTRAINT "DealOrder_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealOrder" ADD CONSTRAINT "DealOrder_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

