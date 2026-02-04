import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { randomString } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export const options = {
  stages: [
    { duration: '10s', target: 1000 }, // Ramp-up
    { duration: '100s', target: 1000, rate: 1000 }, // Sustain
    { duration: '10s', target: 0 },  // Ramp-down
  ],
  thresholds: {
    http_req_duration: ['p(95)<200'], // 95% of requests < 200ms
    checks: ['rate>0.99'], // All checks (status 201 or 409) must pass
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
};

const BASE_URL = 'http://fast-pass-apl-1011026839.ap-northeast-2.elb.amazonaws.com';

export function setup() {
  console.log('Running Setup...');
  
  // 1. Host User Registration & Login
  const hostEmail = `${randomString(8)}@host.com`;
  const password = 'password123';
  
  const regRes = http.post(`${BASE_URL}/auth/signup`, JSON.stringify({
    email: hostEmail, password, name: 'Host User'
  }), { headers: { 'Content-Type': 'application/json' } });
  
  if (!check(regRes, { 'Host Registered': (r) => r.status === 201 })) {
    console.error(`Host Registration Failed: ${regRes.status} ${regRes.body}`);
  }
  
  const loginRes = http.post(`${BASE_URL}/auth/login`, JSON.stringify({
    email: hostEmail, password
  }), { headers: { 'Content-Type': 'application/json' } });

  if (!check(loginRes, { 'Host Login Success': (r) => r.status === 200 || r.status === 201 })) {
     console.error(`Host Login Failed: ${loginRes.status} ${loginRes.body}`);
     // Fail early if login fails
     throw new Error('Host login failed');
  }
  
  const hostToken = loginRes.json('accessToken');
  const authHeaders = { 
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${hostToken}`
  };

  // 2. Create Event
  const eventRes = http.post(`${BASE_URL}/events`, JSON.stringify({
    title: `Load Test Event ${randomString(5)}`,
    description: 'Event for load testing'
  }), { headers: authHeaders });

  check(eventRes, { 'Event Created': (r) => r.status === 201 });
  const eventId = eventRes.json('id');

  // 3. Create Performance (Generates 100 Seats)
  // Future date (tomorrow)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  const perfRes = http.post(`${BASE_URL}/events/${eventId}/performances`, JSON.stringify({
    startAt: tomorrow.toISOString(),
    totalSeats: 100 
  }), { headers: authHeaders });

  check(perfRes, { 'Performance Created': (r) => r.status === 201 });
  const performanceId = perfRes.json('id');

  // 4. Get Seats
  const seatsRes = http.get(`${BASE_URL}/performances/${performanceId}/seats`, {
    headers: authHeaders
  });
  
  check(seatsRes, { 'Seats Retrieved': (r) => r.status === 200 });
  const seats = seatsRes.json();
  const seatIds = seats.map(s => s.id);

  console.log(`Setup Complete: Event ${eventId}, Perf ${performanceId}, Seats ${seatIds.length}`);

  // 5. Create Tester User (Consumer)
  const testerEmail = `${randomString(8)}@test.com`;
  http.post(`${BASE_URL}/auth/signup`, JSON.stringify({
    email: testerEmail, password, name: 'Tester'
  }), { headers: { 'Content-Type': 'application/json' } });

  const testerLoginRes = http.post(`${BASE_URL}/auth/login`, JSON.stringify({
    email: testerEmail, password
  }), { headers: { 'Content-Type': 'application/json' } });
  
  const testerToken = testerLoginRes.json('accessToken');

  return { authToken: testerToken, seatIds };
}

export default function (data) {
  const { authToken, seatIds } = data;
  
  // Pick a random seat to simulate high concurrency on same items
  // or use sequential logic if we want to fill seats (VU ID based).
  // For locking test, random is good.
  const randomSeatId = seatIds[Math.floor(Math.random() * seatIds.length)];

  const payload = JSON.stringify({ seatId: randomSeatId });
  const params = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
  };

  const res = http.post(`${BASE_URL}/reservations`, payload, params);

  // We expect:
  // 201 Created: Reservation successful
  // 409 Conflict: Seat already taken (either by another VU or previously)
  check(res, {
    'Status is 201 or 409': (r) => r.status === 201 || r.status === 409,
    'Duration < 200ms': (r) => r.timings.duration < 200,
  });

  sleep(0.1); // Short sleep to simulate high RPS
}

//   K6_WEB_DASHBOARD=true k6 run k6/load-test.js