-- DropForeignKey
ALTER TABLE "Seat" DROP CONSTRAINT "Seat_performanceId_fkey";

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_performanceId_fkey" FOREIGN KEY ("performanceId") REFERENCES "Performance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
