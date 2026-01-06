import { Injectable } from '@nestjs/common';
import { SeatRepository } from './seat.repository';
import { SeatStatus } from '@prisma/client';

@Injectable()
export class SeatService {
  constructor(private readonly seatRepository: SeatRepository) {}

  async getSeats(performanceId: string, status?: SeatStatus) {
    return this.seatRepository.findSeats(performanceId, status);
  }
}
