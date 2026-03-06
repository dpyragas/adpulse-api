-- CreateEnum
CREATE TYPE "compare_status" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "analyses" ADD COLUMN     "compare_job_id" TEXT;

-- CreateTable
CREATE TABLE "compare_jobs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "status" "compare_status" NOT NULL DEFAULT 'PROCESSING',
    "platform" "platform" NOT NULL,
    "winner_id" TEXT,
    "results" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compare_jobs_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "compare_jobs" ADD CONSTRAINT "compare_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_compare_job_id_fkey" FOREIGN KEY ("compare_job_id") REFERENCES "compare_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
