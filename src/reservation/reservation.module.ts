import { Module } from '@nestjs/common';
import { ReservationController } from './reservation.controller';
import { ReservationService } from './reservation.service';
import { PrismaModule } from '../prisma/prisma.module';

import { ReservationScheduler } from './reservation.scheduler';

@Module({
  imports: [PrismaModule],
  controllers: [ReservationController],
  providers: [ReservationService, ReservationScheduler],
})
export class ReservationModule {}
