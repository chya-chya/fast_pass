ALTER TABLE "Reservation"
ADD COLUMN "testRunId" TEXT,
ADD COLUMN "testRequestId" TEXT;

CREATE INDEX "Reservation_testRunId_idx" ON "Reservation"("testRunId");
CREATE UNIQUE INDEX "Reservation_testRunId_testRequestId_key"
ON "Reservation"("testRunId", "testRequestId");
