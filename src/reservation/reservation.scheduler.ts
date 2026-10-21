import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { ReservationService } from './reservation.service';
import { ReservationMetricsService } from './reservation-metrics.service';

@Injectable()
export class ReservationScheduler {
  private readonly logger = new Logger(ReservationScheduler.name);
  private isProcessing = false;

  constructor(
    private readonly reservationService: ReservationService,
    @Optional()
    private readonly reservationMetrics?: ReservationMetricsService,
  ) {}

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
    if (this.isProcessing) {
      return;
    }
    this.isProcessing = true;
    const startedAt = process.hrtime.bigint();
    let processedCount = 0;

    try {
      // 한 번에 최대 50개씩 처리
      for (let i = 0; i < 50; i++) {
        const processed =
          await this.reservationService.processNextReservation();
        if (!processed) {
          break;
        }
        processedCount += 1;
      }
    } catch (error) {
      this.logger.error('Failed to handle reservation queue', error);
    } finally {
      this.isProcessing = false;
      const durationSeconds =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      this.reservationMetrics?.observeSchedulerBatch(
        processedCount,
        durationSeconds,
      );
    }
  }

  // 5초마다 잔여 좌석 수 동기화 (Eventual Consistency)
  @Interval(5000)
  async handleSeatSync() {
    try {
      await this.reservationService.syncAvailableSeats();
    } catch (error) {
      this.logger.error('Failed to sync available seats', error);
    }
  }
}
