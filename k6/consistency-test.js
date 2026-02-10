import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { randomString } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { Counter } from 'k6/metrics';

const successCounter = new Counter('reservation_success');

export const options = {
  stages: [
    { duration: '10s', target: 500 }, // Ramp-up
    { duration: '30s', target: 500 }, // Sustain
    { duration: '10s', target: 0 },  // Ramp-down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'], 
    checks: ['rate>0.99'], 
  },
};

const BASE_URL = 'http://fast-pass-apl-1011026839.ap-northeast-2.elb.amazonaws.com';

export function setup() {
  console.log('Running Setup...');
  
  const hostEmail = `admin-${randomString(4)}@test.com`;
  const password = 'password123';
  
  // Login as admin (assuming exists or signup)
  http.post(`${BASE_URL}/auth/signup`, JSON.stringify({
    email: hostEmail, password, name: 'Admin'
  }), { headers: { 'Content-Type': 'application/json' } });
  
  const loginRes = http.post(`${BASE_URL}/auth/login`, JSON.stringify({
    email: hostEmail, password
  }), { headers: { 'Content-Type': 'application/json' } });

  const hostToken = loginRes.json('accessToken');
  const authHeaders = { 
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${hostToken}`
  };

  // Create Event & Performance
  const eventRes = http.post(`${BASE_URL}/events`, JSON.stringify({
    title: `Stress Test ${randomString(5)}`,
    description: 'Concurrency Test'
  }), { headers: authHeaders });
  const eventId = eventRes.json('id');

  const perfRes = http.post(`${BASE_URL}/events/${eventId}/performances`, JSON.stringify({
    startAt: new Date(Date.now() + 86400000).toISOString(),
    totalSeats: 50 // Test with 50 seats
  }), { headers: authHeaders });

  const performanceId = perfRes.json('id');

  const seatsRes = http.get(`${BASE_URL}/performances/${performanceId}/seats`, {
    headers: authHeaders
  });
  const seatIds = seatsRes.json().map(s => s.id);

  // Create many users for concurrency
  const users = [];
  for(let i=0; i<10; i++) {
    const email = `user-${i}-${randomString(4)}@test.com`;
    http.post(`${BASE_URL}/auth/signup`, JSON.stringify({ email, password, name: `User ${i}` }), { headers: { 'Content-Type': 'application/json' } });
    const lRes = http.post(`${BASE_URL}/auth/login`, JSON.stringify({ email, password }), { headers: { 'Content-Type': 'application/json' } });
    users.push(lRes.json('accessToken'));
  }

  return { users, seatIds, totalSeats: 50 };
}

export default function (data) {
  const { users, seatIds } = data;
  const authToken = users[Math.floor(Math.random() * users.length)];
  
  // Pick a random seat
  const randomSeatId = seatIds[Math.floor(Math.random() * seatIds.length)];

  const params = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
  };

  const res = http.post(`${BASE_URL}/reservations`, JSON.stringify({ seatId: randomSeatId }), params);

  const isSuccess = res.status === 201;
  const isConflict = res.status === 409;

  if (isSuccess) {
    successCounter.add(1);
  }

  check(res, {
    'Status is 201 or 409': (r) => isSuccess || isConflict,
    'Success or Conflict': (r) => r.status !== 500,
  });

  sleep(0.1); 
}

export function teardown(data) {
  console.log(`Test Finished. Expected successful reservations: <= ${data.totalSeats}`);
}

//   K6_WEB_DASHBOARD=true k6 run k6/consistency-test.js