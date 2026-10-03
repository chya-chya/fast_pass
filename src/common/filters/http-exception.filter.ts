import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiContractException, ApiErrorCode } from '../http/api-contract';
import { getRequestCorrelationId } from '../http/request-correlation';

const DEFAULT_ERRORS: Partial<
  Record<HttpStatus, { code: ApiErrorCode; message: string }>
> = {
  [HttpStatus.BAD_REQUEST]: {
    code: 'INVALID_REQUEST',
    message: '요청 형식이 올바르지 않습니다.',
  },
  [HttpStatus.UNAUTHORIZED]: {
    code: 'AUTHENTICATION_REQUIRED',
    message: '인증이 필요합니다.',
  },
  [HttpStatus.FORBIDDEN]: {
    code: 'ACCESS_DENIED',
    message: '요청 권한이 없습니다.',
  },
  [HttpStatus.NOT_FOUND]: {
    code: 'RESOURCE_NOT_FOUND',
    message: '요청한 리소스를 찾을 수 없습니다.',
  },
  [HttpStatus.CONFLICT]: {
    code: 'CONFLICT',
    message: '요청 상태가 충돌합니다.',
  },
  [HttpStatus.SERVICE_UNAVAILABLE]: {
    code: 'SERVICE_UNAVAILABLE',
    message: '서비스를 일시적으로 사용할 수 없습니다.',
  },
  [HttpStatus.GATEWAY_TIMEOUT]: {
    code: 'REQUEST_TIMEOUT',
    message: '요청 처리 시간이 초과되었습니다.',
  },
};

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = getRequestCorrelationId(request);
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const fallback = DEFAULT_ERRORS[status] || {
      code: 'INTERNAL_ERROR' as const,
      message: '내부 오류가 발생했습니다.',
    };
    const contract =
      exception instanceof ApiContractException
        ? { code: exception.errorCode, message: exception.safeMessage }
        : fallback;

    response.setHeader('X-Request-Id', requestId);
    this.logger.error(
      `${request.method} ${request.path} ${status} code=${contract.code} requestId=${requestId}`,
    );
    response.status(status).json({
      statusCode: status,
      code: contract.code,
      message: contract.message,
      requestId,
    });
  }
}
