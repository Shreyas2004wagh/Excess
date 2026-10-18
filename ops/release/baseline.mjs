import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createPlatform } from './platform.mjs';

export async function prepareBaseline(platform, sha, save) {
  if (!(await platform.isLatest(sha)))
    throw new Error('Baseline must be the latest main commit');
  await platform.requireGreenCi(sha);
  const previous = await platform.current();
  await platform.checkApplicationUnchanged(previous.api.sha, sha);
  await platform.smoke();
  const state = {
    version: 1,
    sha,
    previous,
    candidate: {},
    status: 'preparing-baseline',
  };
  await save(state);
  await platform.configureStartup();
  await platform.preflight();
  await platform.assertCurrent(previous);
  if (!(await platform.isLatest(sha)))
    throw new Error('Main changed during baseline preparation');
  state.candidate.api = await platform.deployApi(sha);
  await save(state);
  await platform.waitApi(state.candidate.api.id, sha);
  await platform.assertCurrent({ api: state.candidate.api, web: previous.web });
  await platform.smoke();
  state.status = 'baseline-ready';
  await save(state);
  return state;
}

async function main() {
  if (
    process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    process.env.AUTOMATION_ENABLED === 'true'
  )
    throw new Error('Dispatch from main with release automation paused');
  const config = JSON.parse(
    await readFile(new URL('./config.json', import.meta.url), 'utf8'),
  );
  const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD']);
  await mkdir('release-output', { recursive: true });
  const save = (state) =>
    writeFile(
      'release-output/baseline-state.json',
      `${JSON.stringify({ ...state, repository: config.repository, runId: process.env.GITHUB_RUN_ID }, null, 2)}\n`,
    );
  await prepareBaseline(createPlatform(config), stdout.trim(), save);
  console.log(
    'Safe startup baseline is live and checked; no migrations applied or frontend aliases changed',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      'Baseline preparation failed. Inspect the saved baseline checkpoint and provider state before retrying.',
    );
    process.exitCode = 1;
  });
