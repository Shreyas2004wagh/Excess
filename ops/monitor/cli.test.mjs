import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
async function invoke(args, extraEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'excess-monitor-cli-'));
  try {
    let result;
    try {
      result = {
        code: 0,
        ...(await exec(process.execPath, [cli, ...args], {
          cwd: directory,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv },
          timeout: 5000,
        })),
      };
    } catch (error) {
      result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
    const report = JSON.parse(
      await readFile(
        join(directory, 'monitor-output/monitor-report.json'),
        'utf8',
      ),
    );
    return { ...result, report };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a deliberate notification failure is synthetic and needs no live token or requests', async () => {
  const result = await invoke(['--test-notification']);
  assert.equal(result.code, 1);
  assert.equal(result.report.kind, 'notification_test');
  assert.equal(result.report.coverage, 'synthetic_notification_test');
});

test('missing/invalid configuration fails before live requests and does not print secrets', async () => {
  const result = await invoke([], {
    MONITOR_METRICS_BEARER_TOKEN: 'private-short',
  });
  assert.equal(result.code, 1);
  assert.equal(result.report.status, 'configuration_error');
  assert.ok(!JSON.stringify(result).includes('private-short'));
});

test('hosted execution is restricted to main in this repository', async () => {
  const result = await invoke(['--test-notification'], {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'attacker/repo',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
  });
  assert.equal(result.report.status, 'configuration_error');
});

test('unknown arguments cannot select destinations or pass secrets through argv', async () => {
  const result = await invoke(['--target=https://attacker.example']);
  assert.equal(result.report.status, 'configuration_error');
});
