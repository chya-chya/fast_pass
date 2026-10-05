-- Remove the legacy uniqueness constraint after the partial replacement exists.
DROP INDEX CONCURRENTLY "Reservation_seatId_key";
