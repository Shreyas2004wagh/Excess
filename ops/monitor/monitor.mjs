import { setTimeout as sleep } from 'node:timers/promises';
import { smokeWeb } from '../release/platform.mjs';

const methods =
  '(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|TRACE|CONNECT|OTHER)';
const counter = new RegExp(
  `^excess_http_requests_total\\{method="${methods}",status="([1-5][0-9]{2})"\\} ([0-9.eE+\\-]+)$`,
);

export class MonitorConfigurationError extends Error {}

export function validateConfiguration(
  config,
  { token, requireMetrics = true } = {},
) {
  if (
    config.repository !== 'Shreyas2004wagh/Excess' ||
    config.apiOrigin !== 'https://excess-demo-api.onrender.com' ||
    config.webOrigin !== 'https://excess-psi.vercel.app' ||
    config.clerkOrigin !== 'https://exact-crayfish-9527.clerk.accounts.dev'
  )
    throw new MonitorConfigurationError(
      'Monitoring targets do not match the approved Excess deployment',
    );
  if (typeof requireMetrics !== 'boolean' || (requireMetrics && !token))
    throw new MonitorConfigurationError(
      'The metrics token is required unless availability-only coverage is explicitly selected',
    );
  if (token !== undefined && !/^[\x21-\x7e]{16,512}$/.test(token))
    throw new MonitorConfigurationError('Invalid metrics token configuration');
}

export async function boundedText(response, maximumBytes = 131072) {
  if (!response.body) throw new Error('Missing response body');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maximumBytes)
      throw new Error('Response exceeded the monitoring limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseMetrics(text) {
  if (!/^# TYPE excess_http_requests_total counter$/m.test(text))
    throw new Error('Metrics contract is missing');
  let processStartedAt, uptimeSeconds;
  let requests = 0,
    serverErrors = 0;
  const seen = new Set();
  for (const line of text.split('\n')) {
    if (line.startsWith('excess_process_start_time_seconds ')) {
      if (processStartedAt !== undefined)
        throw new Error('Duplicate process metric');
      processStartedAt = Number(line.slice(line.indexOf(' ') + 1));
    } else if (line.startsWith('excess_process_uptime_seconds ')) {
      if (uptimeSeconds !== undefined)
        throw new Error('Duplicate uptime metric');
      uptimeSeconds = Number(line.slice(line.indexOf(' ') + 1));
    } else if (line.startsWith('excess_http_requests_total')) {
      const match = line.match(counter);
      if (!match) throw new Error('Unexpected HTTP counter format');
      const key = line.slice(0, line.lastIndexOf(' '));
      if (seen.has(key)) throw new Error('Duplicate HTTP counter');
      seen.add(key);
      const count = Number(match[2]);
      if (!Number.isSafeInteger(count) || count < 0)
        throw new Error('Invalid HTTP counter');
      requests += count;
      if (Number(match[1]) >= 500) serverErrors += count;
    }
  }
  if (
    !Number.isSafeInteger(processStartedAt) ||
    processStartedAt <= 0 ||
    !Number.isFinite(uptimeSeconds) ||
    uptimeSeconds < 0 ||
    !Number.isSafeInteger(requests)
  )
    throw new Error('Invalid process metrics');
  return { processStartedAt, uptimeSeconds, requests, serverErrors };
}

export function validSample(sample) {
  return (
    sample &&
    Number.isSafeInteger(sample.processStartedAt) &&
    sample.processStartedAt > 0 &&
    Number.isFinite(sample.uptimeSeconds) &&
    sample.uptimeSeconds >= 0 &&
    Number.isSafeInteger(sample.requests) &&
    sample.requests >= 0 &&
    Number.isSafeInteger(sample.serverErrors) &&
    sample.serverErrors >= 0 &&
    sample.serverErrors <= sample.requests
  );
}

export function evaluateErrorRate(current, previous) {
  if (!validSample(current)) throw new Error('Invalid metrics sample');
  const delta =
    validSample(previous) &&
    current.processStartedAt === previous.processStartedAt &&
    current.uptimeSeconds >= previous.uptimeSeconds &&
    current.requests >= previous.requests &&
    current.serverErrors >= previous.serverErrors;
  const requests = current.requests - (delta ? previous.requests : 0);
  const serverErrors =
    current.serverErrors - (delta ? previous.serverErrors : 0);
  if (serverErrors > requests)
    throw new Error('Inconsistent HTTP counter delta');
  const rate = requests ? serverErrors / requests : 0;
  return {
    state: requests < 20 ? 'skipped' : rate >= 0.05 ? 'down' : 'up',
    reason:
      requests < 20
        ? 'insufficient_traffic'
        : rate >= 0.05
          ? 'server_error_rate_high'
          : 'within_threshold',
    scope: delta ? 'since_previous_sample' : 'process_lifetime',
    requests,
    serverErrors,
    rate,
    minimumRequests: 20,
    threshold: 0.05,
  };
}

export async function checkDeployment(
  config,
  {
    token,
    requireMetrics = true,
    previous,
    fetcher = fetch,
    wait = sleep,
    checkWeb = () => smokeWeb(config.webOrigin, fetcher, config.clerkOrigin),
    clock = () => new Date().toISOString(),
  } = {},
) {
  validateConfiguration(config, { token, requireMetrics });
  const report = {
    version: 1,
    kind: 'deployment_check',
    observedAt: clock(),
    status: 'healthy',
    coverage: token
      ? 'availability_and_process_error_metrics'
      : 'availability_only',
    checks: [],
    metrics: null,
    errorRate: null,
  };
  const request = (path, headers = {}) =>
    fetcher(`${config.apiOrigin}${path}`, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
      headers,
    });
  let ready = false,
    attempts = 0;
  let dependencies = {
    database: 'unknown',
    redis: 'unknown',
    marketData: 'unknown',
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    attempts++;
    try {
      const response = await request('/api/v1/health/ready');
      if (![200, 503].includes(response.status))
        throw new Error('Invalid readiness HTTP status');
      const body = JSON.parse(await boundedText(response, 16384));
      for (const key of Object.keys(dependencies))
        dependencies[key] = ['up', 'down'].includes(body.checks?.[key])
          ? body.checks[key]
          : 'unknown';
      ready =
        response.status === 200 &&
        body.service === 'excess-api' &&
        body.status === 'ready' &&
        Object.values(dependencies).every((value) => value === 'up');
      if (ready) break;
    } catch {
      /* Provider pages, malformed bodies and network errors never enter reports. */
    }
    if (attempt < 3) await wait(10000);
  }
  report.checks.push({
    name: 'api_readiness',
    state: ready ? 'up' : 'down',
    reason: ready
      ? attempts > 1
        ? 'recovered_within_cold_start_budget'
        : 'ready'
      : 'readiness_unavailable',
    attempts,
    dependencies,
  });

  for (const [name, path] of [
    ['portfolio_authentication', '/api/v1/trading/portfolio'],
    ['metrics_authentication', '/api/v1/metrics'],
  ]) {
    try {
      const response = await request(path);
      report.checks.push({
        name,
        state: response.status === 401 ? 'up' : 'down',
        reason:
          response.status === 401
            ? 'unauthorized_as_expected'
            : 'unexpected_anonymous_access',
      });
      await response.body?.cancel();
    } catch {
      report.checks.push({
        name,
        state: 'down',
        reason: 'authentication_check_unavailable',
      });
    }
  }

  if (token) {
    try {
      const response = await request('/api/v1/metrics', {
        Authorization: `Bearer ${token}`,
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error('Metrics unavailable');
      }
      report.metrics = parseMetrics(await boundedText(response));
      report.errorRate = evaluateErrorRate(report.metrics, previous?.metrics);
      report.checks.push({ name: 'api_error_rate', ...report.errorRate });
    } catch {
      report.checks.push({
        name: 'api_error_rate',
        state: 'down',
        reason: 'protected_metrics_unavailable_or_invalid',
      });
    }
  } else {
    report.checks.push({
      name: 'api_error_rate',
      state: 'skipped',
      reason: 'availability_only_explicitly_selected',
    });
  }
  try {
    await checkWeb();
    report.checks.push({
      name: 'frontend_and_dashboard_protection',
      state: 'up',
      reason: 'landing_and_sign_in_verified',
    });
  } catch {
    report.checks.push({
      name: 'frontend_and_dashboard_protection',
      state: 'down',
      reason: 'frontend_or_authentication_unavailable',
    });
  }
  report.status = report.checks.some((check) => check.state === 'down')
    ? 'unhealthy'
    : 'healthy';
  report.observedAt = clock();
  return report;
}
