-- In-app support: conversations between a shop and CartLift.
CREATE TYPE "SupportAuthor" AS ENUM ('MERCHANT', 'ASSISTANT', 'HUMAN');

CREATE TABLE "SupportThread" (
  "id"         TEXT NOT NULL,
  "shopId"     TEXT NOT NULL,
  "subject"    TEXT NOT NULL,
  "needsHuman" BOOLEAN NOT NULL DEFAULT false,
  "closedAt"   TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupportThread_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SupportMessage" (
  "id"        TEXT NOT NULL,
  "threadId"  TEXT NOT NULL,
  "author"    "SupportAuthor" NOT NULL,
  "body"      TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupportThread_shopId_updatedAt_idx" ON "SupportThread"("shopId", "updatedAt");
CREATE INDEX "SupportMessage_threadId_createdAt_idx" ON "SupportMessage"("threadId", "createdAt");

ALTER TABLE "SupportThread" ADD CONSTRAINT "SupportThread_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_threadId_fkey"
  FOREIGN KEY ("threadId") REFERENCES "SupportThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
