import http from 'k6/http';

const JSON_HEADERS = Object.freeze({ 'Content-Type': 'application/json' });

function requestTags(endpoint, scenario, outcome = 'pending') {
  return { endpoint, scenario, outcome };
}

function authHeaders(token) {
  return { ...JSON_HEADERS, Authorization: `Bearer ${token}` };
}

function testControlHeaders(preflightToken) {
  return {
    ...JSON_HEADERS,
    'X-Test-Preflight-Token': preflightToken,
  };
}

export function signup(baseUrl, payload, scenario = 'smoke_setup') {
  return http.post(`${baseUrl}/auth/signup`, JSON.stringify(payload), {
    headers: JSON_HEADERS,
    tags: requestTags('auth_signup', scenario, 'setup'),
  });
}

export function login(baseUrl, payload, scenario = 'smoke_setup') {
  return http.post(`${baseUrl}/auth/login`, JSON.stringify(payload), {
    headers: JSON_HEADERS,
    tags: requestTags('auth_login', scenario, 'setup'),
  });
}

export function createEvent(baseUrl, token, payload, scenario = 'smoke_setup') {
  return http.post(`${baseUrl}/events`, JSON.stringify(payload), {
    headers: authHeaders(token),
    tags: requestTags('event_create', scenario, 'setup'),
  });
}

export function createPerformance(
  baseUrl,
  token,
  eventId,
  payload,
  scenario = 'smoke_setup',
) {
  return http.post(
    `${baseUrl}/events/${encodeURIComponent(eventId)}/performances`,
    JSON.stringify(payload),
    {
      headers: authHeaders(token),
      tags: requestTags('performance_create', scenario, 'setup'),
    },
  );
}

export function getSeats(
  baseUrl,
  token,
  performanceId,
  scenario = 'smoke_setup',
) {
  return http.get(
    `${baseUrl}/performances/${encodeURIComponent(performanceId)}/seats`,
    {
      headers: authHeaders(token),
      tags: requestTags('seat_list', scenario, 'setup'),
    },
  );
}

export function createReservation(
  baseUrl,
  token,
  seatId,
  runId,
  requestId,
  scenario = 'smoke',
) {
  return http.post(`${baseUrl}/reservations`, JSON.stringify({ seatId }), {
    headers: {
      ...authHeaders(token),
      'X-Request-Id': requestId,
      'X-Test-Run-Id': runId,
      'X-Test-Request-Id': requestId,
    },
    tags: requestTags('reservation_create', scenario),
  });
}

export function cancelReservation(
  baseUrl,
  token,
  reservationId,
  scenario = 'rebooking',
) {
  return http.patch(
    `${baseUrl}/reservations/${encodeURIComponent(reservationId)}/cancel`,
    null,
    {
      headers: authHeaders(token),
      tags: requestTags('reservation_cancel', scenario, 'cancel'),
    },
  );
}

export function registerFixture(
  baseUrl,
  preflightToken,
  runId,
  fixture,
  scenario = 'smoke_setup',
) {
  return http.post(
    `${baseUrl}/health/test-runs/${encodeURIComponent(runId)}/fixture`,
    JSON.stringify(fixture),
    {
      headers: testControlHeaders(preflightToken),
      tags: requestTags('test_fixture_register', scenario, 'setup'),
    },
  );
}

export function applyCacheProfile(
  baseUrl,
  preflightToken,
  runId,
  scenario = 'consistency_setup',
) {
  return http.post(
    `${baseUrl}/health/test-runs/${encodeURIComponent(runId)}/cache-profile`,
    null,
    {
      headers: testControlHeaders(preflightToken),
      tags: requestTags('test_cache_profile', scenario, 'setup'),
    },
  );
}

export function completeProducer(
  baseUrl,
  preflightToken,
  runId,
  scenario = 'smoke_teardown',
) {
  return http.post(
    `${baseUrl}/health/test-runs/${encodeURIComponent(runId)}/producer-complete`,
    null,
    {
      headers: testControlHeaders(preflightToken),
      tags: requestTags('test_producer_complete', scenario, 'teardown'),
    },
  );
}

export function parseRequiredObject(
  response,
  expectedStatus,
  requiredFields,
  label,
) {
  if (!response || response.status !== expectedStatus) {
    throw new Error(`${label} failed with unexpected status`);
  }

  let body;
  try {
    body = response.json();
  } catch (_) {
    throw new Error(`${label} returned invalid JSON`);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`${label} returned an invalid object`);
  }
  for (const field of requiredFields) {
    if (
      body[field] === undefined ||
      body[field] === null ||
      body[field] === ''
    ) {
      throw new Error(`${label} response is missing ${field}`);
    }
  }
  return body;
}

export function parseRequiredArray(
  response,
  expectedStatus,
  itemFields,
  label,
) {
  if (!response || response.status !== expectedStatus) {
    throw new Error(`${label} failed with unexpected status`);
  }

  let body;
  try {
    body = response.json();
  } catch (_) {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!Array.isArray(body) || body.length === 0) {
    throw new Error(`${label} returned an empty or invalid array`);
  }
  body.forEach((item) => {
    for (const field of itemFields) {
      if (
        !item ||
        item[field] === undefined ||
        item[field] === null ||
        item[field] === ''
      ) {
        throw new Error(`${label} item is missing ${field}`);
      }
    }
  });
  return body;
}
