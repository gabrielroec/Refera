-- CreateEnum
CREATE TYPE "FixGenerationStatus" AS ENUM ('pending', 'queued', 'done', 'failed', 'skipped');

-- AlterTable
ALTER TABLE "ProductSnapshot" ADD COLUMN     "carriedFromId" TEXT,
ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "fixStatus" "FixGenerationStatus" NOT NULL DEFAULT 'pending',
ADD COLUMN     "fixesVersion" INTEGER;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "catalogSyncedAt" TIMESTAMP(3),
ADD COLUMN     "questionsGeneratedAt" TIMESTAMP(3),
ADD COLUMN     "simulationQuestions" JSONB,
ADD COLUMN     "storeContextHash" TEXT;

-- CreateTable
CREATE TABLE "ProductMirror" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "data" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "shopifyUpdatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductMirror_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductMirror_shopId_status_shopifyUpdatedAt_idx" ON "ProductMirror"("shopId", "status", "shopifyUpdatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMirror_shopId_productId_key" ON "ProductMirror"("shopId", "productId");

-- CreateIndex
CREATE INDEX "ProductSnapshot_productId_contentHash_idx" ON "ProductSnapshot"("productId", "contentHash");

-- AddForeignKey
ALTER TABLE "ProductMirror" ADD CONSTRAINT "ProductMirror_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
