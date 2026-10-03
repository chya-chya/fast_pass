-- Preserve cancelled reservation history while enforcing at most one active
-- reservation (PENDING or CONFIRMED) for each seat.
DROP INDEX "Reservation_seatId_key";

CREATE UNIQUE INDEX "Reservation_active_seat_key"
ON "Reservation"("seatId")
WHERE "status" IN ('PENDING', 'CONFIRMED');
