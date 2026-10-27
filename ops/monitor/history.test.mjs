import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { previousReport } from './history.mjs';

const repository = 'Shreyas2004wagh/Excess';
function candidate(changes = {}) {
  return {
    id: 101,
    head_branch: 'main',
    head_repository: { full_name: repository },
    path: '.github/workflows/monitor.yml',
    event: 'schedule',
    conclusion: 'success',
    ...changes,
  };
}
function saved(changes = {}) {
  return {
    version: 1,
    kind: 'deployment_check',
    repository,
    runId: '101',
    metrics: {
      processStartedAt: 1700000000,
      uptimeSeconds: 300,
      requests: 100,
      serverErrors: 0,
    },
    ...changes,
  };
}

test('history loads only this workflow/repository and cleans its temporary directory', async () => {
  let directory;
  const result = await previousReport(
    repository,
    '102',
    async (command, args, options) => {
      assert.equal(command, 'gh');
      assert.equal(options.env.MONITOR_METRICS_BEARER_TOKEN, undefined);
      if (args[0] === 'api')
        return { stdout: JSON.stringify({ workflow_runs: [candidate()] }) };
      directory = args[args.indexOf('--dir') + 1];
      await writeFile(
        join(directory, 'monitor-report.json'),
        JSON.stringify(saved()),
      );
      return { stdout: '' };
    },
  );
  assert.equal(result.state, 'loaded');
  assert.equal(result.report.metrics.requests, 100);
  await assert.rejects(access(directory));
});

test('history rejects other branches, workflows, repositories, events and the current run', async () => {
  for (const item of [
    candidate({ head_branch: 'untrusted' }),
    candidate({ path: '.github/workflows/ci.yml' }),
    candidate({ head_repository: { full_name: 'attacker/repo' } }),
    candidate({ event: 'pull_request' }),
    candidate({ id: 102 }),
    candidate({ conclusion: 'cancelled' }),
  ]) {
    let calls = 0;
    const result = await previousReport(repository, '102', async () => {
      calls++;
      return { stdout: JSON.stringify({ workflow_runs: [item] }) };
    });
    assert.equal(result.state, 'none');
    assert.equal(calls, 1);
  }
});

test('synthetic notification tests and inconsistent report identities cannot become baselines', async () => {
  for (const report of [
    saved({ kind: 'notification_test' }),
    saved({ repository: 'attacker/repo' }),
    saved({ runId: '99' }),
    saved({ metrics: { requests: -1 } }),
  ]) {
    const result = await previousReport(
      repository,
      '102',
      async (_command, args) => {
        if (args[0] === 'api')
          return { stdout: JSON.stringify({ workflow_runs: [candidate()] }) };
        await writeFile(
          join(args[args.indexOf('--dir') + 1], 'monitor-report.json'),
          JSON.stringify(report),
        );
        return { stdout: '' };
      },
    );
    assert.equal(result.state, 'unavailable');
  }
});

test('artifact and CLI failures remain private and do not stop lifetime evaluation', async () => {
  const result = await previousReport(repository, '102', async () => {
    throw new Error('signed-private-artifact-url-and-secret');
  });
  assert.deepEqual(result, { state: 'unavailable' });
});
