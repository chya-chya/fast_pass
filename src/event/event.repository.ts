import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class EventRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createEvent(userId: string, data: Prisma.EventCreateWithoutUserInput) {
    return this.prisma.event.create({
      data: {
        ...data,
        user: {
          connect: {
            id: userId,
          },
        },
      },
    });
  }

  async findAllEvents() {
    return this.prisma.event.findMany({
      include: {
        performances: true,
      },
    });
  }

  async findEventById(id: string) {
    return this.prisma.event.findUnique({
      where: { id },
      include: {
        performances: true,
      },
    });
  }

  async updateEvent(userId: string, id: string, data: Prisma.EventUpdateInput) {
    const event = await this.prisma.event.findUnique({
      where: { id },
    });

    if (!event || event.userId !== userId) {
      throw new Error('Unauthorized or Event not found');
    }

    return this.prisma.event.update({
      where: { id },
      data,
    });
  }

  async deleteEvent(userId: string, id: string) {
    // 소유권 확인
    const event = await this.prisma.event.findUnique({
      where: { id },
    });

    if (!event || event.userId !== userId) {
      throw new Error('Unauthorized or Event not found');
    }

    return this.prisma.event.delete({
      where: { id },
    });
  }
}
