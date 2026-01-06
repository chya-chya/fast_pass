import {
  Body,
  Controller,
  Post,
  UseGuards,
  Param,
  Patch,
} from '@nestjs/common';
import { ReservationService } from './reservation.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../common/decorators/get-user.decorator';

@ApiTags('예약')
@Controller('reservations')
export class ReservationController {
  constructor(private readonly reservationService: ReservationService) {}

  @Post()
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '좌석 선점/예약 요청' })
  @ApiResponse({
    status: 201,
    description: '좌석이 성공적으로 선점되었습니다.',
  })
  @ApiResponse({
    status: 409,
    description: '이미 예약된 좌석입니다.',
  })
  create(
    @GetUser() user: { userId: string },
    @Body() createReservationDto: CreateReservationDto,
  ) {
    return this.reservationService.reserveSeat(
      user.userId,
      createReservationDto,
    );
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
  confirm(@Param('id') id: string) {
    // 실무에서는 결제 PG사 웹훅 처리가 일반적이나, 우선 API로 노출
    return this.reservationService.confirmReservation(id);
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
  cancel(@Param('id') id: string) {
    return this.reservationService.cancelReservation(id);
  }
}
