import { BadRequestException, Injectable } from '@nestjs/common';
import { EventRepository } from './event.repository';
import { Prisma } from '@prisma/client';

@Injectable()
export class EventService {
  constructor(private readonly eventRepository: EventRepository) {}

  async createEvent(userId: string, data: Prisma.EventCreateWithoutUserInput) {
    return this.eventRepository.createEvent(userId, data);
  }

  async getAllEvents() {
    return this.eventRepository.findAllEvents();
  }

  async getEventById(id: string) {
    return this.eventRepository.findEventById(id);
  }

  async updateEvent(userId: string, id: string, data: Prisma.EventUpdateInput) {
    return this.eventRepository.updateEvent(userId, id, data);
  }

  async deleteEvent(userId: string, id: string) {
    try {
      return await this.eventRepository.deleteEvent(userId, id);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        throw new BadRequestException(
          '공연 정보(Performance)가 등록된 이벤트는 삭제할 수 없습니다.',
        );
      }
      throw error;
    }
  }
}
