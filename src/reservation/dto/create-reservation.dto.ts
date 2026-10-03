import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class CreateReservationDto {
  @ApiProperty({
    description: '좌석 ID',
    example: 'seat_12345',
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_-]+$/)
  seatId: string;
}
