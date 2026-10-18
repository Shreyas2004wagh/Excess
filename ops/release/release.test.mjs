import test from 'node:test';
import assert from 'node:assert/strict';
import { deploy, rollback } from './release.mjs';

const sha = 'b'.repeat(40);
function fixture() {
  const calls = [];
  const previous = {
    api: { id: 'dep-old', sha: 'a'.repeat(40) },
    web: { id: 'dpl-old', url: 'https://old.vercel.app' },
  };
  const candidate = {
    api: { id: 'dep-new', sha },
    web: { id: 'dpl-new', url: 'https://new.vercel.app' },
  };
  let current = structuredClone(previous);
  const saved = [];
  const platform = {
    isLatest: async () => true,
    preflight: async () => {
      calls.push('preflight');
    },
    current: async () => structuredClone(current),
    checkDatabaseCompatibility: async () => {
      calls.push('database-check');
    },
    smoke: async () => {
      calls.push('smoke');
    },
    smokeApi: async () => {
      calls.push('smoke-api');
    },
    smokeWeb: async () => {
      calls.push('smoke-web');
    },
    stageWeb: async () => {
      calls.push('stage-web');
      return candidate.web;
    },
    assertCurrent: async (expected) => {
      assert.deepEqual(current, expected);
    },
    deployApi: async () => {
      calls.push('deploy-api');
      current.api = candidate.api;
      return candidate.api;
    },
    waitApi: async () => {
      calls.push('wait-api');
    },
    promoteWeb: async () => {
      calls.push('promote-web');
      current.web = candidate.web;
    },
    rollbackWeb: async () => {
      calls.push('rollback-web');
      current.web = previous.web;
    },
    rollbackApi: async () => {
      calls.push('rollback-api');
      current.api = { id: 'dep-restored', sha: previous.api.sha };
      return current.api;
    },
    settleApi: async () => {
      calls.push('settle-api');
    },
  };
  return {
    calls,
    previous,
    candidate,
    platform,
    saved,
    save: async (state) => {
      saved.push(structuredClone(state));
    },
    change: (value) => {
      current = value;
    },
    state: () => ({ version: 2, sha, previous, candidate, status: 'released' }),
  };
}

test('releases the tested commit, stages before API, and saves recovery targets before mutations', async () => {
  const f = fixture();
  f.platform.stageWeb = async () => {
    assert.deepEqual(f.saved[0].previous, f.previous);
    f.calls.push('stage-web');
    return f.candidate.web;
  };
  assert.equal((await deploy(f.platform, sha, f.save)).status, 'released');
  assert.ok(f.calls.indexOf('stage-web') < f.calls.indexOf('deploy-api'));
  assert.ok(f.calls.indexOf('smoke-api') < f.calls.indexOf('promote-web'));
  assert.equal(f.saved.at(-1).status, 'released');
});

test('obsolete CI run cannot perform even preflight or mutation', async () => {
  const f = fixture();
  f.platform.isLatest = async () => false;
  assert.equal((await deploy(f.platform, sha, f.save)).status, 'skipped');
  assert.deepEqual(f.calls, []);
});

test('legacy checkpoints cannot restore builds that apply migrations during startup', async () => {
  const f = fixture();
  await assert.rejects(
    rollback(f.platform, { ...f.state(), version: 1 }, f.save),
    /safe startup version 2/,
  );
  assert.deepEqual(f.calls, []);
});

test('a newer main commit during staging prevents API mutation and promotion', async () => {
  const f = fixture();
  let count = 0;
  f.platform.isLatest = async () => ++count === 1;
  assert.equal((await deploy(f.platform, sha, f.save)).status, 'skipped');
  assert.ok(!f.calls.includes('deploy-api'));
  assert.ok(!f.calls.includes('promote-web'));
});

for (const method of ['preflight', 'checkDatabaseCompatibility', 'smoke']) {
  test(`${method} failure prevents all deploys`, async () => {
    const f = fixture();
    f.platform[method] = async () => {
      throw new Error('unsafe baseline');
    };
    await assert.rejects(deploy(f.platform, sha, f.save), /unsafe baseline/);
    assert.ok(!f.calls.includes('stage-web'));
    assert.ok(!f.calls.includes('deploy-api'));
  });
}

test('frontend build failure never touches the API or promotes a build', async () => {
  const f = fixture();
  f.platform.stageWeb = async () => {
    throw new Error('build failed');
  };
  await assert.rejects(deploy(f.platform, sha, f.save), /build failed/);
  assert.ok(!f.calls.includes('deploy-api'));
  assert.ok(!f.calls.includes('rollback-api'));
  assert.ok(!f.calls.includes('promote-web'));
});

for (const method of ['waitApi', 'smokeApi', 'promoteWeb']) {
  test(`${method} failure triggers API recovery and remains a failed release`, async () => {
    const f = fixture();
    let failed = false;
    const original = f.platform[method];
    f.platform[method] = async (...args) => {
      if (!failed) {
        failed = true;
        throw new Error('release failed');
      }
      return original(...args);
    };
    await assert.rejects(deploy(f.platform, sha, f.save), /release failed/);
    assert.ok(f.calls.includes('rollback-api'));
    assert.equal(f.saved.at(-1).status, 'rolled-back');
    assert.equal(f.saved.at(-1).recovery.api.id, 'dep-restored');
  });
}

test('failure after frontend promotion restores both versions and verifies health', async () => {
  const f = fixture();
  let count = 0;
  f.platform.smoke = async () => {
    if (++count === 2) throw new Error('hosted smoke failed');
  };
  await assert.rejects(deploy(f.platform, sha, f.save), /hosted smoke failed/);
  assert.ok(f.calls.includes('rollback-web'));
  assert.ok(f.calls.includes('rollback-api'));
  assert.equal(count, 3);
  assert.equal(f.saved.at(-1).status, 'rolled-back');
});

test('rollback failure still attempts the other target and reports recovery failure', async () => {
  const f = fixture();
  f.change(f.candidate);
  f.platform.rollbackWeb = async () => {
    throw new Error('web recovery failed');
  };
  await assert.rejects(
    rollback(f.platform, f.state(), f.save),
    /Rollback checks failed/,
  );
  assert.ok(f.calls.includes('rollback-api'));
  assert.equal(f.saved.at(-1).status, 'rollback-failed');
});

test('a failed rollback during release is not silently swallowed', async () => {
  const f = fixture();
  f.platform.smokeApi = async () => {
    throw new Error('bad API');
  };
  f.platform.rollbackApi = async () => {
    throw new Error('rollback unavailable');
  };
  await assert.rejects(
    deploy(f.platform, sha, f.save),
    /recovery needs operator attention/,
  );
  assert.equal(f.saved.at(-1).status, 'rollback-failed');
});

for (const target of ['api', 'web']) {
  test(`stale checkpoint cannot overwrite a newer ${target} deployment`, async () => {
    const f = fixture();
    const newer = structuredClone(f.candidate);
    newer[target].id = 'unrelated';
    f.change(newer);
    await assert.rejects(
      rollback(f.platform, f.state(), f.save),
      /newer or unrelated/,
    );
    assert.ok(!f.calls.includes('rollback-web'));
    assert.ok(!f.calls.includes('rollback-api'));
  });
}

test('pending owned deploy is settled before checking current production', async () => {
  const f = fixture();
  let settled = false;
  f.platform.settleApi = async (id) => {
    assert.equal(id, f.candidate.api.id);
    settled = true;
  };
  f.platform.current = async () => {
    assert.ok(settled);
    return f.previous;
  };
  await rollback(f.platform, f.state(), f.save);
  assert.ok(!f.calls.includes('rollback-api'));
});

test('unknown in-flight deployment prevents all rollback writes', async () => {
  const f = fixture();
  f.platform.settleApi = async () => {
    throw new Error('another deploy');
  };
  await assert.rejects(
    rollback(f.platform, f.state(), f.save),
    /another deploy/,
  );
  assert.ok(!f.calls.includes('rollback-web'));
  assert.ok(!f.calls.includes('rollback-api'));
});

test('a second recovery is idempotent, with no extra deploys', async () => {
  const f = fixture();
  f.change(f.candidate);
  const state = f.state();
  await rollback(f.platform, state, f.save);
  const count = f.calls.filter((value) => value.startsWith('rollback-')).length;
  await rollback(f.platform, state, f.save);
  assert.equal(
    f.calls.filter((value) => value.startsWith('rollback-')).length,
    count,
  );
});

test('invalid checkpoint fails before accessing providers', async () => {
  const f = fixture();
  await assert.rejects(
    rollback(f.platform, {}, f.save),
    /Invalid release checkpoint/,
  );
  assert.deepEqual(f.calls, []);
});
