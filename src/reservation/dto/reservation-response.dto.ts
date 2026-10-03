import { ApiProperty } from '@nestjs/swagger';

export class ReservationAcceptedResponseDto {
  @ApiProperty({ enum: ['RESERVATION_ACCEPTED'] })
  code: 'RESERVATION_ACCEPTED';

  @ApiProperty({ example: '예약 요청이 접수되었습니다.' })
  message: string;

  @ApiProperty({ example: 'request-01HXYZ' })
  requestId: string;

  @ApiProperty({ example: 'reservation-01HXYZ' })
  id: string;

  @ApiProperty({ example: 'user-01HXYZ' })
  userId: string;

  @ApiProperty({ example: 'seat-01HXYZ' })
  seatId: string;

  @ApiProperty({ enum: ['PENDING'] })
  status: 'PENDING';

  @ApiProperty({ type: String, format: 'date-time' })
  reservedAt: Date;
}
