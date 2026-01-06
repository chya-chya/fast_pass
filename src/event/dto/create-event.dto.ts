import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateEventDto {
  @ApiProperty({ example: '콘서트', description: '이벤트 제목' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({
    example: '2025년 최고의 콘서트',
    description: '이벤트 설명',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;
}
