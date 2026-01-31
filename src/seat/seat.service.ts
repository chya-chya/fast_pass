import { Injectable, Inject } from '@nestjs/common';
import { SeatRepository } from './seat.repository';
import { SeatStatus } from '@prisma/client';
import Redis from 'ioredis';

@Injectable()
export class SeatService {
  constructor(
    private readonly seatRepository: SeatRepository,
    @Inject('REDIS_CLIENT') private readonly redisClient: Redis,
  ) {}

  async getSeats(performanceId: string, status?: SeatStatus) {
    const seats = await this.seatRepository.findSeats(performanceId, status);

    // Cache Warming (Fire-and-forget to minimize latency, or await for consistency)
    // For the purpose of the load test, we want to ensure cache is warm.
    if (seats.length > 0) {
      const pipeline = this.redisClient.pipeline();
      seats.forEach((seat) => {
        const key = `seat:${seat.id}:status`;
        // Only set if not exists (nx) to avoid overwriting HELD state if accessed concurrently?
        // Actually, getSeats is usually for display.
        // If we want to warm up for the load test, we just set it to its current DB status.
        // But if a reservation is HELD in cache but not yet in DB?
        // Ideally we should use setnx, but if cache is empty (Cold), setnx works.
        // If cache is HELD, we shouldn't overwrite with AVAILABLE from DB.
        pipeline.set(key, seat.status, 'PX', 600000, 'NX');
      });
      pipeline.exec().catch((err) => {
        console.error('Failed to warm up seat cache', err);
      });
    }

    return seats;
  }
}
