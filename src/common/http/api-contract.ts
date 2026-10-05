import { HttpException, HttpStatus } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';

export const API_ERROR_CODES = [
  'INVALID_REQUEST',
  'AUTHENTICATION_REQUIRED',
  'ACCESS_DENIED',
  'RESOURCE_NOT_FOUND',
  'CONFLICT',
  'SEAT_ALREADY_RESERVED',
  'SEAT_NOT_FOUND',
  'RESERVATION_STORE_UNAVAILABLE',
  'RESERVATION_QUEUE_UNAVAILABLE',
  'RESERVATION_DATABASE_UNAVAILABLE',
  'RESERVATION_LOCK_UNAVAILABLE',
  'REQUEST_TIMEOUT',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export class ApiContractException extends HttpException {
  constructor(
    status: HttpStatus,
    public readonly errorCode: ApiErrorCode,
    public readonly safeMessage: string,
  ) {
    super({ code: errorCode, message: safeMessage }, status);
  }
}

export class ApiErrorResponseDto {
  @ApiProperty({ example: 409 })
  statusCode: number;

  @ApiProperty({ enum: API_ERROR_CODES, example: 'SEAT_ALREADY_RESERVED' })
  code: ApiErrorCode;

  @ApiProperty({ example: '이미 예약된 좌석입니다.' })
  message: string;

  @ApiProperty({ example: 'request-01HXYZ' })
  requestId: string;
}
