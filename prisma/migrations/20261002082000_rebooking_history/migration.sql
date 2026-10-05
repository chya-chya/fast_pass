-- Preserve cancelled reservation history while enforcing at most one active
-- reservation (PENDING or CONFIRMED) for each seat.
CREATE UNIQUE INDEX CONCURRENTLY "Reservation_active_seat_key"
ON "Reservation"("seatId")
WHERE "status" IN ('PENDING', 'CONFIRMED');
