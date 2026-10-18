import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareBaseline } from './baseline.mjs';

function fixture() {
  const calls = [];
  const previous = {
    api: { id: 'old', sha: 'a'.repeat(40) },
    web: { id: 'web' },
  };
  const platform = Object.fromEntries(
    [
      'requireGreenCi',
      'checkApplicationUnchanged',
      'smoke',
      'configureStartup',
      'preflight',
      'assertCurrent',
      'waitApi',
    ].map((name) => [
      name,
      async () => {
        calls.push(name);
      },
    ]),
  );
  platform.isLatest = async () => true;
  platform.current = async () => previous;
  platform.deployApi = async () => {
    calls.push('deployApi');
    return { id: 'new' };
  };
  return { platform, calls };
}

test('baseline checks exact green CI and unchanged application before configuring and deploying', async () => {
  const f = fixture();
  const state = await prepareBaseline(
    f.platform,
    'b'.repeat(40),
    async () => {},
  );
  assert.equal(state.status, 'baseline-ready');
  assert.deepEqual(f.calls.slice(0, 6), [
    'requireGreenCi',
    'checkApplicationUnchanged',
    'smoke',
    'configureStartup',
    'preflight',
    'assertCurrent',
  ]);
  assert.ok(f.calls.includes('waitApi'));
});

for (const failed of ['requireGreenCi', 'checkApplicationUnchanged'])
  test(`baseline ${failed} failure prevents configuration and deployment`, async () => {
    const f = fixture();
    f.platform[failed] = async () => {
      throw new Error('blocked');
    };
    await assert.rejects(
      prepareBaseline(f.platform, 'b'.repeat(40), async () => {}),
      /blocked/,
    );
    assert.ok(!f.calls.includes('configureStartup'));
    assert.ok(!f.calls.includes('deployApi'));
  });
