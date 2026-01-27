import { Module } from '@nestjs/common';
import { makeCounterProvider } from '@willsoto/nestjs-prometheus';
import { ReservationController } from './reservation.controller';
import { ReservationService } from './reservation.service';
import { PrismaModule } from '../prisma/prisma.module';

import { ReservationScheduler } from './reservation.scheduler';

@Module({
  imports: [PrismaModule],
  controllers: [ReservationController],
  providers: [
    ReservationService,
    ReservationScheduler,
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
  ],
})
export class ReservationModule {}
