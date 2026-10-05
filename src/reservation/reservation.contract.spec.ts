import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test, TestingModule } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { App } from 'supertest/types';
import { JwtStrategy } from '../auth/jwt.strategy';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { LoggingInterceptor } from '../common/interceptors/logging.interceptor';
import { ReservationController } from './reservation.controller';
import {
  ReservationDatabaseUnavailableException,
  ReservationLockUnavailableException,
  ReservationQueueUnavailableException,
  ReservationStoreUnavailableException,
  ReservationTimeoutException,
  SeatAlreadyReservedException,
  SeatNotFoundException,
} from './reservation.errors';
import { ReservationService } from './reservation.service';

describe('Reservation API contract', () => {
  let app: INestApplication<App>;
  let token: string;
  const reserveSeat = jest.fn();
  const cancelReservation = jest.fn();
  const confirmReservation = jest.fn();

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret: 'contract-test-secret' }),
      ],
      controllers: [ReservationController],
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: {
            get: (name: string) =>
              name === 'JWT_SECRET' ? 'contract-test-secret' : undefined,
          },
        },
        {
          provide: ReservationService,
          useValue: { reserveSeat, cancelReservation, confirmReservation },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalInterceptors(new LoggingInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    token = module.get(JwtService).sign({
      sub: 'user-1',
      email: 'contract@example.invalid',
    });
  });

  beforeEach(() => {
    reserveSeat.mockReset();
    cancelReservation.mockReset();
    confirmReservation.mockReset();
  });

  afterAll(async () => app.close());

  function reservationRequest() {
    return request(app.getHttpServer())
      .post('/reservations')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Id', 'contract-request-001')
      .send({ seatId: 'seat-001' });
  }

  it('returns the documented accepted contract and correlation header', async () => {
    reserveSeat.mockResolvedValueOnce({
      id: 'reservation-001',
      userId: 'user-1',
      seatId: 'seat-001',
      status: 'PENDING',
      reservedAt: new Date('2026-10-01T00:00:00.000Z'),
    });

    const response = await reservationRequest().expect(201);
    expect(response.headers['x-request-id']).toBe('contract-request-001');
    expect(response.body).toEqual({
      code: 'RESERVATION_ACCEPTED',
      message: '예약 요청이 접수되었습니다.',
      requestId: 'contract-request-001',
      id: 'reservation-001',
      userId: 'user-1',
      seatId: 'seat-001',
      status: 'PENDING',
      reservedAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('returns stable authentication and validation errors', async () => {
    const unauthorized = await request(app.getHttpServer())
      .post('/reservations')
      .set('X-Request-Id', 'contract-request-auth')
      .send({ seatId: 'seat-001' })
      .expect(401);
    expect(unauthorized.body).toEqual({
      statusCode: 401,
      code: 'AUTHENTICATION_REQUIRED',
      message: '인증이 필요합니다.',
      requestId: 'contract-request-auth',
    });

    const invalid = await request(app.getHttpServer())
      .post('/reservations')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Id', 'contract-request-invalid')
      .send({ seatId: '../unsafe', extra: true })
      .expect(400);
    expect(invalid.body).toEqual({
      statusCode: 400,
      code: 'INVALID_REQUEST',
      message: '요청 형식이 올바르지 않습니다.',
      requestId: 'contract-request-invalid',
    });
    expect(reserveSeat).not.toHaveBeenCalled();
  });

  it('requires authentication and forwards the owner for cancellation', async () => {
    await request(app.getHttpServer())
      .patch('/reservations/reservation-001/cancel')
      .set('X-Request-Id', 'cancel-unauthorized')
      .expect(401);
    cancelReservation.mockResolvedValueOnce({
      id: 'reservation-001',
      userId: 'user-1',
      seatId: 'seat-001',
      status: 'CANCELLED',
    });
    await request(app.getHttpServer())
      .patch('/reservations/reservation-001/cancel')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Id', 'cancel-authorized')
      .expect(200);
    expect(cancelReservation).toHaveBeenCalledWith('reservation-001', 'user-1');
  });

  it.each([
    [
      'occupied seat',
      () => new SeatAlreadyReservedException(),
      409,
      'SEAT_ALREADY_RESERVED',
    ],
    ['missing seat', () => new SeatNotFoundException(), 404, 'SEAT_NOT_FOUND'],
    [
      'Redis/Lua failure',
      () => new ReservationStoreUnavailableException(),
      503,
      'RESERVATION_STORE_UNAVAILABLE',
    ],
    [
      'enqueue failure',
      () => new ReservationQueueUnavailableException(),
      503,
      'RESERVATION_QUEUE_UNAVAILABLE',
    ],
    [
      'database failure',
      () => new ReservationDatabaseUnavailableException(),
      503,
      'RESERVATION_DATABASE_UNAVAILABLE',
    ],
    [
      'lock failure',
      () => new ReservationLockUnavailableException(),
      503,
      'RESERVATION_LOCK_UNAVAILABLE',
    ],
    [
      'server timeout',
      () => new ReservationTimeoutException(),
      504,
      'REQUEST_TIMEOUT',
    ],
  ] as const)(
    '%s maps to the structured contract',
    async (_, createException, status, code) => {
      reserveSeat.mockRejectedValueOnce(createException());
      const response = await reservationRequest().expect(status);
      expect(response.body).toMatchObject({
        statusCode: status,
        code,
        requestId: 'contract-request-001',
      });
      expect(response.body.message).toEqual(expect.any(String));
    },
  );

  it('redacts internal exception details from the response', async () => {
    reserveSeat.mockRejectedValueOnce(
      new Error('postgresql://user:password@internal/database'),
    );
    const response = await reservationRequest().expect(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: '내부 오류가 발생했습니다.',
      requestId: 'contract-request-001',
    });
    expect(JSON.stringify(response.body)).not.toContain('postgresql://');
    expect(JSON.stringify(response.body)).not.toContain('password');
  });

  it('publishes Swagger schemas matching the runtime DTOs', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('contract').setVersion('1').build(),
    );
    const operation = document.paths['/reservations']?.post;
    expect(operation?.responses).toEqual(
      expect.objectContaining({
        201: expect.any(Object),
        400: expect.any(Object),
        401: expect.any(Object),
        404: expect.any(Object),
        409: expect.any(Object),
        500: expect.any(Object),
        503: expect.any(Object),
        504: expect.any(Object),
      }),
    );
    expect(document.components?.schemas).toEqual(
      expect.objectContaining({
        ReservationAcceptedResponseDto: expect.objectContaining({
          required: expect.arrayContaining([
            'code',
            'message',
            'requestId',
            'id',
            'status',
          ]),
        }),
        ApiErrorResponseDto: expect.objectContaining({
          required: expect.arrayContaining([
            'statusCode',
            'code',
            'message',
            'requestId',
          ]),
        }),
      }),
    );
  });
});
