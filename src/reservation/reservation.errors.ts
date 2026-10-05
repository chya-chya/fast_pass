import { HttpStatus } from '@nestjs/common';
import { ApiContractException } from '../common/http/api-contract';

export class SeatAlreadyReservedException extends ApiContractException {
  constructor() {
    super(
      HttpStatus.CONFLICT,
      'SEAT_ALREADY_RESERVED',
      '이미 예약된 좌석입니다.',
    );
  }
}

export class SeatNotFoundException extends ApiContractException {
  constructor() {
    super(HttpStatus.NOT_FOUND, 'SEAT_NOT_FOUND', '좌석을 찾을 수 없습니다.');
  }
}

export class ReservationStoreUnavailableException extends ApiContractException {
  constructor() {
    super(
      HttpStatus.SERVICE_UNAVAILABLE,
      'RESERVATION_STORE_UNAVAILABLE',
      '예약 상태 저장소를 일시적으로 사용할 수 없습니다.',
    );
  }
}

export class ReservationQueueUnavailableException extends ApiContractException {
  constructor() {
    super(
      HttpStatus.SERVICE_UNAVAILABLE,
      'RESERVATION_QUEUE_UNAVAILABLE',
      '예약 대기열을 일시적으로 사용할 수 없습니다.',
    );
  }
}

export class ReservationDatabaseUnavailableException extends ApiContractException {
  constructor() {
    super(
      HttpStatus.SERVICE_UNAVAILABLE,
      'RESERVATION_DATABASE_UNAVAILABLE',
      '예약 데이터 저장소를 일시적으로 사용할 수 없습니다.',
    );
  }
}

export class ReservationLockUnavailableException extends ApiContractException {
  constructor() {
    super(
      HttpStatus.SERVICE_UNAVAILABLE,
      'RESERVATION_LOCK_UNAVAILABLE',
      '좌석 잠금 서비스를 일시적으로 사용할 수 없습니다.',
    );
  }
}

export class ReservationTimeoutException extends ApiContractException {
  constructor() {
    super(
      HttpStatus.GATEWAY_TIMEOUT,
      'REQUEST_TIMEOUT',
      '예약 처리 시간이 초과되었습니다.',
    );
  }
}
