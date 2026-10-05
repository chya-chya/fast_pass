import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TestEnvironmentHealthController } from './test-environment-health.controller';
import { TestRunController } from './test-run.controller';

@Module({
  imports: [PrismaModule],
  controllers: [TestEnvironmentHealthController, TestRunController],
})
export class HealthModule {}
