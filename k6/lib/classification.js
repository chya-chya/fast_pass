const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,95}$/;

function parseContractBody(response) {
  try {
    const body = response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return body;
  } catch (_) {
    return null;
  }
}

function hasCorrelation(body) {
  return (
    typeof body.requestId === 'string' && SAFE_REQUEST_ID.test(body.requestId)
  );
}

function hasSafeMessage(body) {
  return typeof body.message === 'string' && body.message.length > 0;
}

function isTransportTimeout(response) {
  return (
    response.status === 0 &&
    (response.error_code === 1050 ||
      (typeof response.error === 'string' &&
        /(?:timeout|timed out)/i.test(response.error)))
  );
}

export function classifyReservationResponse(response) {
  if (!response) return 'unexpected_error';
  if (isTransportTimeout(response)) return 'timeout';
  if (response.status === 0) return 'unexpected_error';

  const body = parseContractBody(response);
  if (!body || !hasCorrelation(body) || !hasSafeMessage(body)) {
    return 'unexpected_error';
  }
  if (
    response.status === 201 &&
    body.code === 'RESERVATION_ACCEPTED' &&
    body.status === 'PENDING' &&
    typeof body.id === 'string' &&
    body.id.length > 0
  ) {
    return 'accepted';
  }
  if (
    response.status === 409 &&
    body.statusCode === 409 &&
    body.code === 'SEAT_ALREADY_RESERVED'
  ) {
    return 'expected_conflict';
  }
  if (
    response.status === 504 &&
    body.statusCode === 504 &&
    body.code === 'REQUEST_TIMEOUT'
  ) {
    return 'timeout';
  }
  return 'unexpected_error';
}
