import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyReservationResponse } from '../lib/classification.js';

function response(status, body, extra = {}) {
  return {
    status,
    json() {
      if (body instanceof Error) throw body;
      return body;
    },
    ...extra,
  };
}

test('accepts only the exact 201 reservation contract', () => {
  assert.equal(
    classifyReservationResponse(
      response(201, {
        code: 'RESERVATION_ACCEPTED',
        message: 'accepted',
        requestId: 'request-001',
        id: 'reservation-001',
        status: 'PENDING',
      }),
    ),
    'accepted',
  );
  assert.equal(
    classifyReservationResponse(
      response(201, {
        code: 'RESERVATION_ACCEPTED',
        message: 'accepted',
        requestId: 'request-001',
        status: 'PENDING',
      }),
    ),
    'unexpected_error',
  );
});

test('counts only 409 SEAT_ALREADY_RESERVED as expected conflict', () => {
  const contract = {
    statusCode: 409,
    code: 'SEAT_ALREADY_RESERVED',
    message: 'conflict',
    requestId: 'request-001',
  };
  assert.equal(
    classifyReservationResponse(response(409, contract)),
    'expected_conflict',
  );
  assert.equal(
    classifyReservationResponse(
      response(503, {
        ...contract,
        statusCode: 503,
        code: 'RESERVATION_QUEUE_UNAVAILABLE',
      }),
    ),
    'unexpected_error',
  );
  assert.equal(
    classifyReservationResponse(
      response(409, { ...contract, code: 'RESERVATION_QUEUE_UNAVAILABLE' }),
    ),
    'unexpected_error',
  );
});

test('recognizes only explicit server or transport timeouts', () => {
  assert.equal(
    classifyReservationResponse(
      response(504, {
        statusCode: 504,
        code: 'REQUEST_TIMEOUT',
        message: 'timeout',
        requestId: 'request-001',
      }),
    ),
    'timeout',
  );
  assert.equal(
    classifyReservationResponse(
      response(0, null, { error_code: 1050, error: 'request timeout' }),
    ),
    'timeout',
  );
  assert.equal(
    classifyReservationResponse(
      response(0, null, { error_code: 1210, error: 'connection refused' }),
    ),
    'unexpected_error',
  );
});

test('fails closed for missing, empty, malformed, and mismatched responses', () => {
  assert.equal(classifyReservationResponse(undefined), 'unexpected_error');
  assert.equal(
    classifyReservationResponse(response(409, new Error('invalid JSON'))),
    'unexpected_error',
  );
  assert.equal(
    classifyReservationResponse(response(409, null)),
    'unexpected_error',
  );
  assert.equal(
    classifyReservationResponse(
      response(409, {
        statusCode: 503,
        code: 'SEAT_ALREADY_RESERVED',
        message: 'conflict',
        requestId: 'request-001',
      }),
    ),
    'unexpected_error',
  );
  assert.equal(
    classifyReservationResponse(
      response(409, {
        statusCode: 409,
        code: 'SEAT_ALREADY_RESERVED',
        message: 'conflict',
      }),
    ),
    'unexpected_error',
  );
});
