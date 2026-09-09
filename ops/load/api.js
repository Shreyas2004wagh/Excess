import { check, sleep } from 'k6';
import http from 'k6/http';
import { Rate } from 'k6/metrics';

const applicationErrors = new Rate('application_errors');
const virtualUsers = Number(__ENV.K6_VUS || 10);

export const options = {
  stages: [
    { duration: __ENV.K6_RAMP_UP || '15s', target: virtualUsers },
    { duration: __ENV.K6_DURATION || '30s', target: virtualUsers },
    { duration: __ENV.K6_RAMP_DOWN || '10s', target: 0 },
  ],
  thresholds: {
    application_errors: ['rate<0.01'],
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
  },
};

const baseUrl = (__ENV.K6_BASE_URL || 'http://localhost:4000/api/v1').replace(
  /\/$/,
  '',
);
const token = __ENV.K6_AUTH_TOKEN;

export function setup() {
  if (!token) {
    throw new Error(
      'K6_AUTH_TOKEN must contain a short-lived Clerk session token',
    );
  }

  const readiness = http.get(`${baseUrl}/health/ready`, {
    tags: { endpoint: 'readiness' },
  });
  if (
    !check(readiness, { 'API is ready': (response) => response.status === 200 })
  ) {
    throw new Error(`Excess API is not ready (HTTP ${readiness.status})`);
  }
}

export default function () {
  const parameters = {
    headers: { Authorization: `Bearer ${token}` },
  };
  const responses = http.batch([
    [
      'GET',
      `${baseUrl}/market-data/instruments/BTC-USD`,
      null,
      {
        ...parameters,
        tags: { endpoint: 'instrument' },
      },
    ],
    [
      'GET',
      `${baseUrl}/trading/portfolio`,
      null,
      {
        ...parameters,
        tags: { endpoint: 'portfolio' },
      },
    ],
    [
      'GET',
      `${baseUrl}/notifications`,
      null,
      {
        ...parameters,
        tags: { endpoint: 'notifications' },
      },
    ],
  ]);

  for (const response of responses) {
    const successful = check(response, {
      'request completed successfully': (result) => result.status === 200,
    });
    applicationErrors.add(!successful);
  }
  sleep(1);
}
