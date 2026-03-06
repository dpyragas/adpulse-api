-- CreateEnum
CREATE TYPE "media_type" AS ENUM ('IMAGE', 'VIDEO');

-- AlterTable
ALTER TABLE "analyses" ADD COLUMN     "media_type" "media_type" NOT NULL DEFAULT 'IMAGE';
