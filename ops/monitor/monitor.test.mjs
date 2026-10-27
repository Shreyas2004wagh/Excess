import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  boundedText,
  checkDeployment,
  evaluateErrorRate,
  MonitorConfigurationError,
  parseMetrics,
  validateConfiguration,
} from './monitor.mjs';

const config = JSON.parse(
  await readFile(new URL('../release/config.json', import.meta.url), 'utf8'),
);
const token = 'metrics-fixture-secret-123';
const ready = {
  service: 'excess-api',
  status: 'ready',
  checks: { database: 'up', redis: 'up', marketData: 'up' },
};
const sample = (
  requests = 100,
  serverErrors = 0,
  processStartedAt = 1700000000,
) => ({ processStartedAt, uptimeSeconds: 600, requests, serverErrors });
function metrics(requests = 100, errors = 0) {
  return `# TYPE excess_http_requests_total counter\nexcess_process_start_time_seconds 1700000000\nexcess_process_uptime_seconds 600\nexcess_http_requests_total{method="GET",status="200"} ${requests - errors}\nexcess_http_requests_total{method="POST",status="500"} ${errors}\n`;
}
function fixture(overrides = {}) {
  const calls = [];
  const waits = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'manual');
    assert.equal(options.method, 'GET');
    assert.ok(options.signal);
    if (url.endsWith('/health/ready')) return Response.json(ready);
    if (url.endsWith('/trading/portfolio'))
      return new Response('', { status: 401 });
    if (url.endsWith('/metrics') && options.headers.Authorization)
      return new Response(metrics());
    if (url.endsWith('/metrics')) return new Response('', { status: 401 });
    throw new Error('Unexpected monitoring target');
  };
  return {
    calls,
    waits,
    options: {
      token,
      fetcher,
      wait: async (ms) => {
        waits.push(ms);
      },
      checkWeb: async () => true,
      ...overrides,
    },
  };
}

test('full checks verify API dependencies, auth boundaries, metrics and frontend', async () => {
  const f = fixture();
  const report = await checkDeployment(config, f.options);
  assert.equal(report.status, 'healthy');
  assert.equal(report.checks.length, 5);
  assert.ok(report.checks.every((check) => check.state === 'up'));
  assert.equal(report.coverage, 'availability_and_process_error_metrics');
  assert.equal(report.errorRate.scope, 'process_lifetime');
  assert.ok(!JSON.stringify(report).includes(token));
  const credentialed = f.calls.filter(
    (call) => call.options.headers.Authorization,
  );
  assert.equal(credentialed.length, 1);
  assert.equal(credentialed[0].url, `${config.apiOrigin}/api/v1/metrics`);
});

test('missing metrics token is a configuration error before any requests', async () => {
  const f = fixture({ token: undefined });
  await assert.rejects(
    checkDeployment(config, f.options),
    MonitorConfigurationError,
  );
  assert.equal(f.calls.length, 0);
});

test('availability-only is explicit and reports its missing error coverage', async () => {
  const f = fixture({ token: undefined, requireMetrics: false });
  const report = await checkDeployment(config, f.options);
  assert.equal(report.status, 'healthy');
  assert.equal(report.coverage, 'availability_only');
  assert.equal(
    report.checks.find((check) => check.name === 'api_error_rate').state,
    'skipped',
  );
  assert.ok(!f.calls.some((call) => call.options.headers.Authorization));
});

test('unapproved destinations and invalid credentials fail closed', () => {
  for (const field of ['apiOrigin', 'webOrigin', 'clerkOrigin', 'repository']) {
    assert.throws(() =>
      validateConfiguration(
        { ...config, [field]: 'https://attacker.example' },
        { token },
      ),
    );
  }
  for (const bad of [
    'short',
    'secret\nInjected: header',
    ' secret-that-is-long-enough',
  ])
    assert.throws(() => validateConfiguration(config, { token: bad }));
});

test('cold-start recovery retries are bounded and reported separately', async () => {
  const f = fixture();
  const original = f.options.fetcher;
  let attempts = 0;
  f.options.fetcher = (url, options) => {
    if (url.endsWith('/health/ready') && ++attempts < 4)
      throw new Error('private provider detail');
    return original(url, options);
  };
  const report = await checkDeployment(config, f.options);
  assert.equal(report.status, 'healthy');
  assert.equal(report.checks[0].attempts, 4);
  assert.equal(report.checks[0].reason, 'recovered_within_cold_start_budget');
  assert.deepEqual(f.waits, [10000, 10000, 10000]);
});

test('HTTP 200 cannot hide a down dependency or the wrong service', async () => {
  for (const body of [
    { ...ready, checks: { ...ready.checks, redis: 'down' } },
    { ...ready, service: 'other-service' },
  ]) {
    const f = fixture();
    const original = f.options.fetcher;
    f.options.fetcher = (url, options) =>
      url.endsWith('/health/ready')
        ? Response.json(body)
        : original(url, options);
    const report = await checkDeployment(config, f.options);
    assert.equal(report.status, 'unhealthy');
    assert.equal(report.checks[0].attempts, 4);
  }
});

test('anonymous portfolio or metrics exposure is an incident, not a successful check', async () => {
  for (const path of ['/trading/portfolio', '/metrics']) {
    const f = fixture();
    const original = f.options.fetcher;
    f.options.fetcher = (url, options) =>
      url.endsWith(path) && !options.headers.Authorization
        ? new Response('private response', { status: 200 })
        : original(url, options);
    const report = await checkDeployment(config, f.options);
    assert.equal(report.status, 'unhealthy');
    assert.ok(
      report.checks.some(
        (check) => check.reason === 'unexpected_anonymous_access',
      ),
    );
    assert.ok(!JSON.stringify(report).includes('private response'));
  }
});

test('metrics redirects and invalid bodies are rejected without exposing their contents', async () => {
  for (const response of [
    () =>
      new Response('', {
        status: 302,
        headers: { Location: 'https://attacker.example/secret' },
      }),
    () => new Response('private-token-body'),
  ]) {
    const f = fixture();
    const original = f.options.fetcher;
    f.options.fetcher = (url, options) =>
      options.headers.Authorization ? response() : original(url, options);
    const report = await checkDeployment(config, f.options);
    assert.equal(report.status, 'unhealthy');
    assert.ok(!JSON.stringify(report).includes('attacker'));
    assert.ok(!JSON.stringify(report).includes('private-token-body'));
  }
});

test('frontend/auth failures are reported without raw redirect or cookie details', async () => {
  const f = fixture({
    checkWeb() {
      throw new Error('session=PRIVATE_COOKIE');
    },
  });
  const report = await checkDeployment(config, f.options);
  assert.equal(report.status, 'unhealthy');
  assert.ok(!JSON.stringify(report).includes('PRIVATE_COOKIE'));
});

test('a measured server-error spike fails the monitoring run', async () => {
  const f = fixture();
  const original = f.options.fetcher;
  f.options.fetcher = (url, options) =>
    options.headers.Authorization
      ? new Response(metrics(100, 10))
      : original(url, options);
  const report = await checkDeployment(config, f.options);
  assert.equal(report.status, 'unhealthy');
  assert.equal(report.errorRate.reason, 'server_error_rate_high');
});

test('metric parsing ignores unrelated gauges but rejects corrupted counters', () => {
  assert.deepEqual(parseMetrics(metrics()), sample());
  for (const invalid of [
    'private-provider-response',
    metrics().replace(' 600\n', ' NaN\n'),
    metrics().replace(' 100\n', ' -1\n'),
    `${metrics()}excess_http_requests_total{method="GET",status="200"} 1\n`,
    metrics().replace('status="200"', 'status="999"'),
    metrics().replace('excess_process_start_time_seconds 1700000000\n', ''),
  ])
    assert.throws(() => parseMetrics(invalid));
});

test('error-rate windows use comparable deltas, otherwise current-process lifetime', () => {
  const previous = sample(80, 0);
  const current = sample(100, 2);
  assert.equal(
    evaluateErrorRate(current, previous).scope,
    'since_previous_sample',
  );
  assert.equal(evaluateErrorRate(current, previous).rate, 0.1);
  assert.equal(evaluateErrorRate(current, previous).state, 'down');
  for (const old of [
    undefined,
    sample(1000, 50, 1600000000),
    sample(1000, 50),
  ]) {
    const result = evaluateErrorRate(current, old);
    assert.equal(result.scope, 'process_lifetime');
    assert.equal(result.state, 'up');
    assert.equal(result.rate, 0.02);
  }
});

test('low traffic is explicitly inconclusive; malformed deltas are not accepted', () => {
  assert.equal(evaluateErrorRate(sample(19, 1)).reason, 'insufficient_traffic');
  assert.equal(evaluateErrorRate(sample(20, 1)).state, 'down');
  assert.throws(() => evaluateErrorRate(sample(10, 11)));
  assert.throws(() => evaluateErrorRate(sample(100, 80), sample(99, 0)));
});

test('response bodies are size bounded', async () => {
  await assert.rejects(boundedText(new Response('x'.repeat(200)), 100));
});
