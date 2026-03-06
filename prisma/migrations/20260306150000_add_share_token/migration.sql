-- AlterTable
ALTER TABLE "analyses" ADD COLUMN "share_token" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "analyses_share_token_key" ON "analyses"("share_token");
