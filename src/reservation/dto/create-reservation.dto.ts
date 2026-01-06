import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateReservationDto {
  @ApiProperty({
    description: '좌석 ID',
    example: 'seat_12345',
  })
  @IsNotEmpty()
  @IsString()
  seatId: string;
}
