import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PerformanceRepository } from './performance.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class PerformanceService {
  constructor(
    private readonly performanceRepository: PerformanceRepository,
    private readonly prisma: PrismaService,
  ) {}

  async create(userId: string, data: Prisma.PerformanceUncheckedCreateInput) {
    const event = await this.prisma.event.findUnique({
      where: { id: data.eventId },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    if (event.userId !== userId) {
      throw new ForbiddenException(
        'You do not have permission to add performance to this event',
      );
    }

    if (typeof data.startAt === 'string') {
      data.startAt = new Date(data.startAt);
    }

    // Generate seats based on totalSeats
    const seats = Array.from({ length: data.totalSeats }, (_, i) => ({
      seatNumber: `${i + 1}`,
      // Add other default fields if necessary
    }));

    return this.performanceRepository.create({
      ...data,
      seats: {
        create: seats,
      },
    });
  }

  async findAll() {
    return this.performanceRepository.findAll();
  }

  async findOne(id: string) {
    const performance = await this.performanceRepository.findOne(id);
    if (!performance) {
      throw new NotFoundException(`Performance with ID ${id} not found`);
    }
    return performance;
  }

  async update(
    userId: string,
    id: string,
    data: Prisma.PerformanceUpdateInput,
  ) {
    // Verify ownership
    const performance = await this.performanceRepository.findOne(id);
    if (!performance) {
      throw new NotFoundException(`Performance with ID ${id} not found`);
    }

    if (performance.event.userId !== userId) {
      throw new ForbiddenException(
        'You do not have permission to update this performance',
      );
    }

    if (data.startAt && typeof data.startAt === 'string') {
      data.startAt = new Date(data.startAt);
    }

    return this.performanceRepository.update(id, data);
  }

  async delete(userId: string, id: string) {
    // Verify ownership
    const performance = await this.performanceRepository.findOne(id);
    if (!performance) {
      throw new NotFoundException(`Performance with ID ${id} not found`);
    }

    if (performance.event.userId !== userId) {
      throw new ForbiddenException(
        'You do not have permission to delete this performance',
      );
    }

    return this.performanceRepository.delete(id);
  }
}
