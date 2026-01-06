import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ReservationService } from './reservation.service';

@Injectable()
export class ReservationScheduler {
  private readonly logger = new Logger(ReservationScheduler.name);

  constructor(private readonly reservationService: ReservationService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleExpiredReservations() {
    this.logger.log('Checking for expired reservations...');
    const now = new Date();
    const threshold = new Date(now.getTime() - 5 * 60 * 1000); // 5분 전

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
}
