import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { ReservationService } from './reservation.service';

@Injectable()
export class ReservationScheduler {
  private readonly logger = new Logger(ReservationScheduler.name);

  constructor(private readonly reservationService: ReservationService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleExpiredReservations() {
    this.logger.log('Checking for expired reservations...');
    const now = new Date();
    const threshold = new Date(now.getTime() - 10 * 60 * 1000); // 10분 전

    try {
      const count =
        await this.reservationService.expireOverdueReservations(threshold);
      if (count > 0) {
        this.logger.log(`Expired ${count} pending reservations.`);
      }
    } catch (error) {
      this.logger.error('Failed to expire reservations', error);
    }
  }

  @Interval(100)
  async handleReservationQueue() {
    try {
      // 한 번에 최대 50개씩 처리
      for (let i = 0; i < 50; i++) {
        const processed = await this.reservationService.processNextReservation();
        if (!processed) {
          break;
        }
      }
    } catch (error) {
      this.logger.error('Failed to handle reservation queue', error);
    }
  }
}
