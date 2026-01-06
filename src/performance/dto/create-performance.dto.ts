import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsNumber, IsOptional } from 'class-validator';

export class CreatePerformanceDto {
  @ApiProperty({
    example: '2025-01-01T20:00:00Z',
    description: 'Performance start time',
  })
  @IsDateString()
  startAt: string;

  @ApiProperty({ example: 150, description: 'Total number of seats' })
  @IsNumber()
  totalSeats: number;

  @ApiProperty({
    example: 150,
    description: 'Available seats',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  availableSeats?: number;
}
