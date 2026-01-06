import { Controller, Get, Param, Query } from '@nestjs/common';
import { SeatService } from './seat.service';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SeatStatus } from '@prisma/client';

@ApiTags('좌석')
@Controller('performances/:id/seats')
export class SeatController {
  constructor(private readonly seatService: SeatService) {}

  @Get()
  @ApiOperation({ summary: '예약 가능 좌석 조회' })
  @ApiResponse({ status: 200, description: '좌석 목록을 반환합니다.' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: SeatStatus,
    description: '좌석 상태 필터',
  })
  getSeats(@Param('id') id: string, @Query('status') status?: SeatStatus) {
    return this.seatService.getSeats(id, status);
  }
}
