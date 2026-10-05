import {
  Body,
  Controller,
  Post,
  UseGuards,
  Param,
  Patch,
  Headers,
  Req,
} from '@nestjs/common';
import { ReservationService } from './reservation.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../common/decorators/get-user.decorator';
import type { Request } from 'express';
import { ApiErrorResponseDto } from '../common/http/api-contract';
import { getRequestCorrelationId } from '../common/http/request-correlation';
import { ReservationAcceptedResponseDto } from './dto/reservation-response.dto';

@ApiTags('예약')
@Controller('reservations')
export class ReservationController {
  constructor(private readonly reservationService: ReservationService) {}

  @Post()
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '좌석 선점/예약 요청' })
  @ApiHeader({
    name: 'X-Request-Id',
    required: false,
    description:
      '3~96자의 안전한 요청 상관관계 ID. 없거나 잘못되면 서버가 생성합니다.',
  })
  @ApiResponse({
    status: 201,
    description: '좌석 예약 요청이 대기열에 접수되었습니다.',
    type: ReservationAcceptedResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: '`INVALID_REQUEST`: 입력 형식 오류',
    type: ApiErrorResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: '`AUTHENTICATION_REQUIRED`: 인증 실패',
    type: ApiErrorResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: '`SEAT_NOT_FOUND`: 존재하지 않는 좌석',
    type: ApiErrorResponseDto,
  })
  @ApiResponse({
    status: 409,
    description: '`SEAT_ALREADY_RESERVED`: 정상적인 좌석 경합',
    type: ApiErrorResponseDto,
  })
  @ApiResponse({
    status: 503,
    description:
      '`RESERVATION_STORE_UNAVAILABLE`, `RESERVATION_QUEUE_UNAVAILABLE`, `RESERVATION_DATABASE_UNAVAILABLE`, `RESERVATION_LOCK_UNAVAILABLE`',
    type: ApiErrorResponseDto,
  })
  @ApiResponse({
    status: 504,
    description: '`REQUEST_TIMEOUT`: 예약 처리 timeout',
    type: ApiErrorResponseDto,
  })
  @ApiResponse({
    status: 500,
    description: '`INTERNAL_ERROR`: 정의되지 않은 내부 오류',
    type: ApiErrorResponseDto,
  })
  async create(
    @GetUser() user: { userId: string },
    @Body() createReservationDto: CreateReservationDto,
    @Req() request: Request,
    @Headers('x-test-run-id') testRunId?: string,
    @Headers('x-test-request-id') testRequestId?: string,
  ): Promise<ReservationAcceptedResponseDto> {
    const reservation = await this.reservationService.reserveSeat(
      user.userId,
      createReservationDto,
      testRunId,
      testRequestId,
    );
    return {
      code: 'RESERVATION_ACCEPTED',
      message: '예약 요청이 접수되었습니다.',
      requestId: getRequestCorrelationId(request),
      id: reservation.id,
      userId: reservation.userId,
      seatId: reservation.seatId,
      status: 'PENDING',
      reservedAt: reservation.reservedAt,
    };
  }

  @Post(':id/confirm')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '예약 확정 (결제 완료)' })
  @ApiResponse({
    status: 200,
    description: '예약이 확정되었습니다.',
  })
  @ApiResponse({
    status: 404,
    description: '예약을 찾을 수 없습니다.',
  })
  @ApiResponse({
    status: 409,
    description: '결제 대기 중인 예약만 확정할 수 있습니다.',
  })
  confirm(@GetUser() user: { userId: string }, @Param('id') id: string) {
    // 실무에서는 결제 PG사 웹훅 처리가 일반적이나, 우선 API로 노출
    return this.reservationService.confirmReservation(id, user.userId);
  }

  @Patch(':id/cancel')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '예약 취소' })
  @ApiResponse({
    status: 200,
    description: '예약이 취소되었습니다.',
  })
  @ApiResponse({
    status: 404,
    description: '예약을 찾을 수 없습니다.',
  })
  cancel(@GetUser() user: { userId: string }, @Param('id') id: string) {
    return this.reservationService.cancelReservation(id, user.userId);
  }
}
