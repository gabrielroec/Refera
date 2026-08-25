-- CreateEnum
CREATE TYPE "ScanPhase" AS ENUM ('queued', 'catalogue', 'analysing', 'questions', 'simulating', 'fixing', 'finished');

-- AlterTable
ALTER TABLE "Scan" ADD COLUMN     "phase" "ScanPhase" NOT NULL DEFAULT 'queued';
