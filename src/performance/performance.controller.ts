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
import { PerformanceService } from './performance.service';
import { GetUser } from '../common/decorators/get-user.decorator';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CreatePerformanceDto } from './dto/create-performance.dto';
import { UpdatePerformanceDto } from './dto/update-performance.dto';
import { AuthGuard } from '@nestjs/passport';

@ApiTags('공연')
@Controller('')
export class PerformanceController {
  constructor(private readonly performanceService: PerformanceService) {}

  @Post('events/:eventId/performances')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: '공연 생성' })
  @ApiResponse({
    status: 201,
    description: '공연이 성공적으로 생성되었습니다.',
  })
  create(
    @GetUser() user: { userId: string },
    @Param('eventId') eventId: string,
    @Body() data: CreatePerformanceDto,
  ) {
    return this.performanceService.create(user.userId, { ...data, eventId });
  }

  @Get('performances')
  @ApiOperation({ summary: '모든 공연 조회' })
  @ApiResponse({ status: 200, description: '모든 공연 목록을 반환합니다.' })
  findAll() {
    return this.performanceService.findAll();
  }

  @Get('performances/:id')
  @ApiOperation({ summary: '공연 상세 조회' })
  @ApiResponse({ status: 200, description: '공연 정보를 반환합니다.' })
  @ApiResponse({ status: 404, description: '공연을 찾을 수 없습니다.' })
  findOne(@Param('id') id: string) {
    return this.performanceService.findOne(id);
  }

  @Patch('performances/:id')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: '공연 수정' })
  @ApiResponse({
    status: 200,
    description: '공연이 성공적으로 수정되었습니다.',
  })
  update(
    @GetUser() user: { userId: string },
    @Param('id') id: string,
    @Body() data: UpdatePerformanceDto,
  ) {
    return this.performanceService.update(user.userId, id, data);
  }

  @Delete('performances/:id')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: '공연 삭제' })
  @ApiResponse({
    status: 200,
    description: '공연이 성공적으로 삭제되었습니다.',
  })
  remove(@GetUser() user: { userId: string }, @Param('id') id: string) {
    return this.performanceService.delete(user.userId, id);
  }
}
