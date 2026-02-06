import { Module } from '@nestjs/common';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { EventModule } from './event/event.module';
import { PerformanceModule } from './performance/performance.module';
import {
  utilities as nestWinstonModuleUtilities,
  WinstonModule,
} from 'nest-winston';
import { SeatModule } from './seat/seat.module';
import { ReservationModule } from './reservation/reservation.module';
import { RedisModule } from './common/redis/redis.module';
import * as winston from 'winston';
import 'winston-daily-rotate-file';
import 'winston-mongodb';

import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrometheusModule.register(),
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    AuthModule,
    EventModule,
    PerformanceModule,
    WinstonModule.forRoot({
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.ms(),
            nestWinstonModuleUtilities.format.nestLike('FastPass', {
              colors: true,
              prettyPrint: true,
            }),
          ),
        }),
        // new winston.transports.MongoDB({
        //   level: 'info',
        //   db: process.env.MONGO_URI || 'mongodb://mongo:27017/fast_pass_logs',
        //   collection: 'logs',
        //   format: winston.format.combine(
        //     winston.format.timestamp(),
        //     winston.format.json(),
        //   ),
        // }),
      ],
    }),
    SeatModule,
    ReservationModule,
    RedisModule,
  ],
  controllers: [AppController],
  providers: [AppService, PrismaService],
})
export class AppModule {}
