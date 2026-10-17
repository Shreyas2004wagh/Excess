import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createPlatform } from './platform.mjs';
import { deploy, rollback } from './release.mjs';

const exec = promisify(execFile);
const config = JSON.parse(
  await readFile(new URL('./config.json', import.meta.url), 'utf8'),
);
const env = process.env;
const mode = process.argv[2];
const checkpoint = 'release-output/release-state.json';
const context = {
  repository: config.repository,
  renderServiceId: config.renderServiceId,
  vercelProjectId: config.vercelProjectId,
  runId: env.GITHUB_RUN_ID,
};
await mkdir('release-output', { recursive: true });
const save = (state) =>
  writeFile(
    checkpoint,
    `${JSON.stringify({ ...state, ...context }, null, 2)}\n`,
    { mode: 0o600 },
  );

try {
  const platform = createPlatform(config);
  if (mode === 'deploy') {
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
    const run = event.workflow_run;
    if (
      env.GITHUB_EVENT_NAME !== 'workflow_run' ||
      run?.event !== 'push' ||
      run.conclusion !== 'success' ||
      run.head_branch !== 'main' ||
      run.head_repository?.full_name !== config.repository ||
      run.path !== '.github/workflows/ci.yml'
    )
      throw new Error('Only successful main-branch push CI runs may release');
    const { stdout } = await exec('git', ['rev-parse', 'HEAD']);
    if (stdout.trim() !== run.head_sha)
      throw new Error('Checkout does not match the CI-tested commit');
    const result = await deploy(platform, run.head_sha, save);
    await save(result);
    console.log(`Release ${result.status}: ${run.head_sha}`);
  } else if (mode === 'rollback') {
    if (
      env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      env.GITHUB_REF !== 'refs/heads/main'
    )
      throw new Error('Rollback must be dispatched from main');
    const runId = env.RELEASE_RUN_ID;
    if (!/^\d+$/.test(runId ?? ''))
      throw new Error('A numeric release workflow run ID is required');
    const { stdout } = await exec('gh', [
      'api',
      `repos/${config.repository}/actions/runs/${runId}`,
    ]);
    const run = JSON.parse(stdout);
    if (
      run.path !== '.github/workflows/release.yml' ||
      !['workflow_run', 'workflow_dispatch'].includes(run.event) ||
      run.status !== 'completed' ||
      run.head_branch !== 'main' ||
      run.repository?.full_name !== config.repository
    )
      throw new Error(
        'Checkpoint must come from a completed main-branch Release workflow in this repository',
      );
    await exec('gh', [
      'run',
      'download',
      runId,
      '--repo',
      config.repository,
      '--name',
      'release-state',
      '--dir',
      'release-input',
    ]);
    const state = JSON.parse(
      await readFile('release-input/release-state.json', 'utf8'),
    );
    if (
      state.repository !== config.repository ||
      state.runId !== runId ||
      state.renderServiceId !== config.renderServiceId ||
      state.vercelProjectId !== config.vercelProjectId ||
      !state.previous
    )
      throw new Error('Release checkpoint does not match this project/run');
    await rollback(platform, state, save);
    console.log('Saved production versions restored and checked');
  } else throw new Error('Usage: node ops/release/cli.mjs deploy|rollback');
} catch (error) {
  function describe(value) {
    console.error(value.message);
    for (const child of value.errors ?? []) describe(child);
  }
  describe(error);
  process.exitCode = 1;
} finally {
  if (env.GITHUB_STEP_SUMMARY) {
    let state;
    try {
      state = JSON.parse(await readFile(checkpoint, 'utf8'));
    } catch {
      /* Preflight may have failed before a checkpoint existed. */
    }
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `## Release result\n\n${state?.status ?? 'Stopped before release'}\n\nCommit: \`${state?.sha ?? 'not deployed'}\`\n\nThe release-state artifact records deployment IDs for recovery. No database rollback is performed.\n`,
    );
  }
}
