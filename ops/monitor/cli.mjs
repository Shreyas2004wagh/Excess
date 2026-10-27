import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { checkDeployment, MonitorConfigurationError } from './monitor.mjs';
import { previousReport } from './history.mjs';

const config = JSON.parse(
  await readFile(new URL('../release/config.json', import.meta.url), 'utf8'),
);
const args = process.argv.slice(2);
let report;
try {
  if (
    args.some(
      (arg) => !['--availability-only', '--test-notification'].includes(arg),
    ) ||
    args.length > 1
  )
    throw new MonitorConfigurationError('Unsupported monitor arguments');
  const workflow = process.env.GITHUB_ACTIONS === 'true';
  if (
    workflow &&
    (process.env.GITHUB_REPOSITORY !== config.repository ||
      process.env.GITHUB_REF !== 'refs/heads/main' ||
      !['schedule', 'workflow_dispatch'].includes(
        process.env.GITHUB_EVENT_NAME,
      ))
  )
    throw new MonitorConfigurationError(
      'Hosted monitoring must run on trusted main',
    );
  if (args.includes('--test-notification')) {
    report = {
      version: 1,
      kind: 'notification_test',
      observedAt: new Date().toISOString(),
      status: 'unhealthy',
      coverage: 'synthetic_notification_test',
      checks: [
        {
          name: 'notification_test',
          state: 'down',
          reason: 'intentional_delivery_test_no_live_requests',
        },
      ],
      metrics: null,
      errorRate: null,
    };
  } else {
    const history =
      workflow && !args.includes('--availability-only')
        ? await previousReport(config.repository, process.env.GITHUB_RUN_ID)
        : { state: 'not_used' };
    report = await checkDeployment(config, {
      token: args.includes('--availability-only')
        ? undefined
        : process.env.MONITOR_METRICS_BEARER_TOKEN || undefined,
      requireMetrics: !args.includes('--availability-only'),
      previous: history.report,
    });
    report.baseline = history.state;
  }
} catch (error) {
  report = {
    version: 1,
    observedAt: new Date().toISOString(),
    status: 'configuration_error',
    coverage: 'none',
    checks: [],
    metrics: null,
    errorRate: null,
    reason:
      error instanceof MonitorConfigurationError
        ? 'monitor_configuration_invalid'
        : 'monitor_execution_failed',
  };
}
if (process.env.GITHUB_ACTIONS === 'true') {
  report.repository = config.repository;
  report.runId = process.env.GITHUB_RUN_ID;
}
await mkdir('monitor-output', { recursive: true });
await writeFile(
  'monitor-output/monitor-report.json',
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
);
const lines = [
  '## Excess operational check',
  '',
  `Result: **${report.status}**`,
  '',
  `Coverage: \`${report.coverage}\``,
  '',
  ...report.checks.map(
    (check) => `- ${check.name}: ${check.state} (${check.reason})`,
  ),
  '',
  'Process-local counters can reset or disappear when the free service sleeps. Low traffic is reported as skipped, not a proven zero error rate.',
  'This check does not deploy, restart, trade, reset accounts, or restore data.',
  '',
];
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
console.log(
  `Operational check: ${report.status}; coverage: ${report.coverage}`,
);
if (report.status !== 'healthy') process.exitCode = 1;
