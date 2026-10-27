import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { validSample } from './monitor.mjs';

const exec = promisify(execFile);

export async function previousReport(repository, currentRunId, execute = exec) {
  let directory;
  const run = (args) =>
    execute('gh', args, {
      timeout: 30000,
      maxBuffer: 1048576,
      env: Object.fromEntries(
        ['PATH', 'HOME', 'GH_TOKEN', 'GITHUB_TOKEN']
          .filter((name) => process.env[name])
          .map((name) => [name, process.env[name]]),
      ),
    });
  try {
    if (repository !== 'Shreyas2004wagh/Excess')
      return { state: 'unavailable' };
    const { stdout } = await run([
      'api',
      `repos/${repository}/actions/workflows/monitor.yml/runs?status=completed&branch=main&per_page=5`,
    ]);
    const data = JSON.parse(stdout);
    const candidate = data.workflow_runs?.find(
      (item) =>
        String(item.id) !== String(currentRunId) &&
        item.head_branch === 'main' &&
        item.head_repository?.full_name === repository &&
        item.path === '.github/workflows/monitor.yml' &&
        ['schedule', 'workflow_dispatch'].includes(item.event) &&
        item.conclusion !== 'cancelled',
    );
    if (!candidate) return { state: 'none' };
    if (!Number.isSafeInteger(candidate.id) || candidate.id < 1)
      return { state: 'unavailable' };
    directory = await mkdtemp(join(tmpdir(), 'excess-monitor-history-'));
    await run([
      'run',
      'download',
      String(candidate.id),
      '--repo',
      repository,
      '--name',
      'monitor-report',
      '--dir',
      directory,
    ]);
    const saved = JSON.parse(
      await readFile(join(directory, 'monitor-report.json'), 'utf8'),
    );
    if (
      saved.version !== 1 ||
      saved.kind !== 'deployment_check' ||
      saved.repository !== repository ||
      saved.runId !== String(candidate.id) ||
      !validSample(saved.metrics)
    )
      return { state: 'unavailable' };
    return { state: 'loaded', report: { metrics: saved.metrics } };
  } catch {
    // gh errors can include signed artifact URLs or response bodies. The
    // monitor can still evaluate the current process lifetime without history.
    return { state: 'unavailable' };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
