import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, Performance } from '@prisma/client';

@Injectable()
export class PerformanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    data: Prisma.PerformanceUncheckedCreateInput,
  ): Promise<Performance> {
    return this.prisma.performance.create({
      data,
    });
  }

  async findAll() {
    return this.prisma.performance.findMany();
  }

  async findOne(id: string) {
    return this.prisma.performance.findUnique({
      where: { id },
      include: {
        event: true,
      },
    });
  }

  async update(id: string, data: Prisma.PerformanceUpdateInput) {
    return this.prisma.performance.update({
      where: { id },
      data,
    });
  }

  async delete(id: string) {
    return this.prisma.performance.delete({
      where: { id },
    });
  }
}
