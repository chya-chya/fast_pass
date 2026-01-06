import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, Seat, SeatStatus } from '@prisma/client';

@Injectable()
export class SeatRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.SeatUncheckedCreateInput): Promise<Seat> {
    return this.prisma.seat.create({
      data,
    });
  }

  async findAll(): Promise<Seat[]> {
    return this.prisma.seat.findMany();
  }

  async findOne(id: string): Promise<Seat | null> {
    return this.prisma.seat.findUnique({
      where: { id },
    });
  }

  async update(id: string, data: Prisma.SeatUpdateInput): Promise<Seat> {
    return this.prisma.seat.update({
      where: { id },
      data,
    });
  }

  async delete(id: string): Promise<Seat> {
    return this.prisma.seat.delete({
      where: { id },
    });
  }

  async findSeats(performanceId: string, status?: SeatStatus): Promise<Seat[]> {
    const where: Prisma.SeatWhereInput = {
      performanceId,
    };

    if (status) {
      where.status = status;
    }

    return this.prisma.seat.findMany({
      where,
      orderBy: {
        seatNumber: 'asc',
      },
    });
  }
}
