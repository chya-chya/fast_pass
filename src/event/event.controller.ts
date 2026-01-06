import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { EventService } from './event.service';
import { GetUser } from '../common/decorators/get-user.decorator';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';

@ApiTags('이벤트')
@Controller('events')
export class EventController {
  constructor(private readonly eventService: EventService) {}

  @Post()
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: '이벤트 생성' })
  @ApiResponse({
    status: 201,
    description: '이벤트가 성공적으로 생성되었습니다.',
  })
  async createEvent(
    @GetUser() user: { userId: string },
    @Body() data: CreateEventDto,
  ) {
    return this.eventService.createEvent(user.userId, data);
  }

  @Get()
  @ApiOperation({ summary: '모든 이벤트 조회' })
  @ApiResponse({ status: 200, description: '모든 이벤트 목록을 반환합니다.' })
  async getAllEvents() {
    return this.eventService.getAllEvents();
  }

  @Get(':id')
  @ApiOperation({ summary: '이벤트 상세 조회' })
  @ApiResponse({ status: 200, description: '이벤트 정보를 반환합니다.' })
  @ApiResponse({ status: 404, description: '이벤트를 찾을 수 없습니다.' })
  async getEventById(@Param('id') id: string) {
    return this.eventService.getEventById(id);
  }

  @Patch(':id')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: '이벤트 수정' })
  @ApiResponse({
    status: 200,
    description: '이벤트가 성공적으로 수정되었습니다.',
  })
  async updateEvent(
    @GetUser() user: { userId: string },
    @Param('id') id: string,
    @Body() data: UpdateEventDto,
  ) {
    return this.eventService.updateEvent(user.userId, id, data);
  }

  @Delete(':id')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: '이벤트 삭제' })
  @ApiResponse({
    status: 200,
    description: '이벤트가 성공적으로 삭제되었습니다.',
  })
  async deleteEvent(
    @GetUser() user: { userId: string },
    @Param('id') id: string,
  ) {
    return this.eventService.deleteEvent(user.userId, id);
  }
}
