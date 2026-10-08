import { Module } from '@nestjs/common';
import {
  makeCounterProvider,
  makeGaugeProvider,
  makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';
import { ReservationController } from './reservation.controller';
import { ReservationService } from './reservation.service';
import { PrismaModule } from '../prisma/prisma.module';

import { ReservationScheduler } from './reservation.scheduler';
import { TestRunTrackerService } from './test-run-tracker.service';
import { ReservationMetricsService } from './reservation-metrics.service';

@Module({
  imports: [PrismaModule],
  controllers: [ReservationController],
  providers: [
    ReservationService,
    ReservationScheduler,
    TestRunTrackerService,
    ReservationMetricsService,
    makeCounterProvider({
      name: 'reservation_request_total',
      help: 'Total number of reservation requests received',
    }),
    makeCounterProvider({
      name: 'reservation_lock_total',
      help: 'Total number of reservation lock attempts',
      labelNames: ['status'], // success, fail
    }),
    makeCounterProvider({
      name: 'reservation_queue_total',
      help: 'Total number of reservations pushed to Redis queue',
      labelNames: ['status'], // success, fail
    }),
    makeCounterProvider({
      name: 'reservation_processed_total',
      help: 'Total number of reservations processed by scheduler',
      labelNames: ['status'], // success, fail
    }),
    makeCounterProvider({
      name: 'reservation_request_outcome_total',
      help: 'Reservation request outcomes by stable API contract category',
      labelNames: ['outcome'],
    }),
    makeCounterProvider({
      name: 'reservation_lua_result_total',
      help: 'Reservation seat-state Lua results',
      labelNames: ['result'],
    }),
    makeHistogramProvider({
      name: 'reservation_persistence_latency_seconds',
      help: 'Latency from Redis Stream enqueue to database persistence',
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    }),
    makeHistogramProvider({
      name: 'reservation_scheduler_batch_size',
      help: 'Successfully processed reservations per scheduler batch',
      buckets: [0, 1, 5, 10, 25, 50],
    }),
    makeHistogramProvider({
      name: 'reservation_scheduler_batch_duration_seconds',
      help: 'Reservation scheduler batch duration in seconds',
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    }),
    makeGaugeProvider({
      name: 'reservation_queue_depth_messages',
      help: 'Current outstanding reservation stream entries',
    }),
    makeGaugeProvider({
      name: 'reservation_queue_processing_messages',
      help: 'Current reservation stream pending entries owned by consumers',
    }),
    makeGaugeProvider({
      name: 'reservation_queue_retry_messages',
      help: 'Current pending reservation entries with delivery count above one',
    }),
    makeGaugeProvider({
      name: 'reservation_queue_dlq_messages',
      help: 'Current reservation dead-letter stream entries',
    }),
    makeGaugeProvider({
      name: 'reservation_queue_oldest_message_age_seconds',
      help: 'Age of the oldest outstanding reservation stream entry',
    }),
    makeGaugeProvider({
      name: 'reservation_queue_metrics_collection_up',
      help: 'Whether the latest Redis reservation metric collection succeeded',
    }),
    makeGaugeProvider({
      name: 'reservation_queue_retry_scan_complete',
      help: 'Whether the retry gauge covered every current pending entry',
    }),
  ],
})
export class ReservationModule {}
