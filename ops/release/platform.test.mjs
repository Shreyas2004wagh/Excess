import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createPlatform,
  jsonRequest,
  poll,
  smokeApi,
  smokeWeb,
} from './platform.mjs';

const config = JSON.parse(
  await readFile(new URL('./config.json', import.meta.url), 'utf8'),
);
function providerFixture() {
  const env = {
    RENDER_API_KEY: 'render-secret',
    VERCEL_TOKEN: 'vercel-secret',
    GH_TOKEN: 'github-secret',
    GITHUB_REPOSITORY: config.repository,
  };
  const requests = [];
  const commands = [];
  const sha = 'b'.repeat(40);
  const data = {
    service: {
      repo: `https://github.com/${config.repository}`,
      branch: 'main',
      ownerId: config.renderOwnerId,
      autoDeploy: 'no',
      serviceDetails: { url: config.apiOrigin },
    },
    project: { id: config.vercelProjectId, link: null },
    deploys: [
      {
        deploy: {
          id: 'dep-old',
          commit: { id: 'a'.repeat(40) },
          status: 'live',
        },
      },
    ],
    deploy: { id: 'dep-new', commit: { id: sha }, status: 'live' },
    alias: {
      projectId: config.vercelProjectId,
      deploymentId: 'dpl-old',
      deployment: { url: 'old.vercel.app' },
    },
    web: {
      id: 'dpl-new',
      projectId: config.vercelProjectId,
      target: 'production',
      readyState: 'READY',
      url: 'new.vercel.app',
      meta: { githubCommitSha: sha },
    },
    diff: '',
  };
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    const path = new URL(url).pathname;
    let value;
    if (path.endsWith('/git/ref/heads/main')) value = { object: { sha } };
    else if (path.includes('/v9/projects/')) value = data.project;
    else if (path.includes('/v4/aliases/')) value = data.alias;
    else if (path.includes('/v13/deployments/')) value = data.web;
    else if (path.endsWith('/rollback')) value = { id: 'dep-recovery' };
    else if (path.endsWith('/deploys'))
      value = options.method === 'POST' ? data.deploy : data.deploys;
    else if (path.includes('/deploys/')) value = data.deploy;
    else value = data.service;
    return Response.json(value);
  };
  const run = async (file, args) => {
    commands.push({ file, args });
    if (data.runError) throw data.runError;
    if (file === 'git') return { stdout: data.diff };
    if (args.includes('deploy'))
      return {
        stdout: JSON.stringify({ status: 'ok', deployment: { id: 'dpl-new' } }),
      };
    return { stdout: '' };
  };
  return {
    data,
    requests,
    commands,
    sha,
    platform: createPlatform(config, env, {
      fetcher,
      run,
      wait: async () => {},
    }),
  };
}

test('provider adapters resolve the real response shapes and deploy the exact SHA', async () => {
  const f = providerFixture();
  await f.platform.preflight();
  assert.equal((await f.platform.current()).web.id, 'dpl-old');
  assert.equal(await f.platform.isLatest(f.sha), true);
  assert.equal((await f.platform.deployApi(f.sha)).id, 'dep-new');
  const request = f.requests.find((item) => item.options.method === 'POST');
  assert.equal(JSON.parse(request.options.body).commitId, f.sha);
  await f.platform.waitApi('dep-new', f.sha);
});

test('Vercel staging uses production config without promoting domains and verifies metadata', async () => {
  const f = providerFixture();
  assert.equal((await f.platform.stageWeb(f.sha)).id, 'dpl-new');
  const args = f.commands[0].args;
  assert.ok(args.includes('vercel@64.0.2'));
  assert.ok(args.includes('--prod'));
  assert.ok(args.includes('--skip-domain'));
  assert.ok(args.includes(`githubCommitSha=${f.sha}`));
  f.data.web.meta.githubCommitSha = 'wrong';
  await assert.rejects(f.platform.stageWeb(f.sha), /did not match/);
});

test('preflight rejects competing provider auto-deploy and an unrelated Vercel project', async () => {
  const f = providerFixture();
  f.data.service.autoDeploy = 'yes';
  await assert.rejects(f.platform.preflight(), /auto-deploy/);
  f.data.service.autoDeploy = 'no';
  f.data.project.link = { repo: 'Excess' };
  await assert.rejects(f.platform.preflight(), /auto-deployment/);
});

test('current production refuses pending work and a wrong-project alias', async () => {
  const f = providerFixture();
  f.data.deploys[0].deploy.status = 'queued';
  await assert.rejects(f.platform.current(), /in-progress/);
  f.data.deploys[0].deploy.status = 'live';
  f.data.alias.projectId = 'another-project';
  await assert.rejects(f.platform.current(), /Cannot resolve/);
});

test('schema changes are blocked and the diff is limited to Prisma data definitions', async () => {
  const f = providerFixture();
  await f.platform.checkDatabaseCompatibility('a'.repeat(40), f.sha);
  assert.equal(f.commands[0].args.at(-1), 'packages/database/prisma');
  f.data.diff = 'packages/database/prisma/migrations/new/migration.sql\n';
  await assert.rejects(
    f.platform.checkDatabaseCompatibility('a'.repeat(40), f.sha),
    /release manually/,
  );
});

test('provider terminal failure and mismatched commit are never reported live', async () => {
  const f = providerFixture();
  f.data.deploy.status = 'build_failed';
  await assert.rejects(f.platform.waitApi('dep-new', f.sha), /build_failed/);
  f.data.deploy.status = 'live';
  f.data.deploy.commit.id = 'wrong';
  await assert.rejects(f.platform.waitApi('dep-new', f.sha), /wrong commit/);
});

test('rollback uses saved Render deploy ID, not a rebuild of latest main', async () => {
  const f = providerFixture();
  assert.equal((await f.platform.rollbackApi('dep-old')).id, 'dep-recovery');
  const request = f.requests[0];
  assert.ok(request.url.endsWith('/rollback'));
  assert.deepEqual(JSON.parse(request.options.body), { deployId: 'dep-old' });
});

test('CLI diagnostics preserve useful stderr but redact credentials and never expose argv/stdout', async () => {
  const f = providerFixture();
  f.data.runError = Object.assign(
    new Error('argv includes --token vercel-secret'),
    {
      stderr:
        'Error: Invalid project for vercel-secret; render-secret github-secret',
      stdout: 'PRIVATE_DEPLOYMENT_CONFIG',
    },
  );
  await assert.rejects(f.platform.stageWeb(f.sha), (error) => {
    assert.match(error.message, /Invalid project/);
    assert.ok(
      !/vercel-secret|render-secret|github-secret|PRIVATE_DEPLOYMENT_CONFIG|argv/.test(
        error.message,
      ),
    );
    return true;
  });
});

test('release credentials and repository identity fail closed', () => {
  assert.throws(() => createPlatform({}, {}), /Missing required/);
  assert.throws(
    () =>
      createPlatform(
        { repository: 'expected/repo' },
        {
          RENDER_API_KEY: 'x',
          VERCEL_TOKEN: 'y',
          GH_TOKEN: 'z',
          GITHUB_REPOSITORY: 'fork/repo',
        },
      ),
    /different repository/,
  );
});

test('provider error output never includes a response body/secret', async () => {
  const fetcher = async () =>
    new Response('credential=SUPER_SECRET', { status: 403 });
  await assert.rejects(
    jsonRequest('https://api.example.com', 'SUPER_SECRET', undefined, fetcher),
    (error) =>
      error.message === 'Provider request failed (HTTP 403)' && error.fatal,
  );
});

test('deploy POST is not automatically retried on ambiguous network failure', async () => {
  let count = 0;
  await assert.rejects(
    jsonRequest(
      'https://api.example.com',
      'secret',
      { commitId: 'sha' },
      async (_url, options) => {
        count++;
        assert.equal(options.redirect, 'error');
        assert.equal(options.method, 'POST');
        throw new Error('network timeout');
      },
    ),
    /network timeout/,
  );
  assert.equal(count, 1);
});

test('bounded polling recovers from transient failures and waits for success', async () => {
  let attempts = 0;
  let waits = 0;
  assert.equal(
    await poll(
      async () => {
        if (++attempts === 1) throw new Error('temporary');
        return attempts === 3;
      },
      {
        attempts: 4,
        wait: async () => {
          waits++;
        },
      },
    ),
    true,
  );
  assert.equal(waits, 2);
});

test('bounded polling times out and stops immediately on terminal failures', async () => {
  await assert.rejects(
    poll(async () => false, { attempts: 2, wait: async () => {} }),
    /Timed out/,
  );
  let count = 0;
  await assert.rejects(
    poll(async () => {
      count++;
      const error = new Error('terminal deploy failure');
      error.fatal = true;
      throw error;
    }),
    /terminal/,
  );
  assert.equal(count, 1);
});

const readiness = {
  service: 'excess-api',
  status: 'ready',
  checks: { database: 'up', redis: 'up', marketData: 'up' },
};
test('API smoke checks all dependencies and enforces unauthenticated 401', async () => {
  const fetcher = async (url) =>
    url.endsWith('/health/ready')
      ? Response.json(readiness)
      : new Response('', { status: 401 });
  assert.equal(await smokeApi('https://api.example.com', fetcher), true);
});

for (const dependency of ['database', 'redis', 'marketData']) {
  test(`HTTP 200 with unhealthy ${dependency} is rejected`, async () => {
    const body = structuredClone(readiness);
    body.checks[dependency] = 'down';
    await assert.rejects(
      smokeApi('https://api.example.com', async () => Response.json(body)),
      /readiness failed/,
    );
  });
}

test('an accidentally public portfolio route fails the release', async () => {
  await assert.rejects(
    smokeApi('https://api.example.com', async (url) =>
      url.endsWith('/health/ready')
        ? Response.json(readiness)
        : Response.json({}),
    ),
    /authentication protection/,
  );
});

test('frontend verifies landing content and same-origin sign-in redirect', async () => {
  const fetcher = async (url) =>
    url.endsWith('/dashboard')
      ? new Response('', {
          status: 307,
          headers: { location: '/sign-in?redirect_url=dashboard' },
        })
      : new Response('Excess <a href="/sign-in">Sign in</a>');
  assert.equal(await smokeWeb('https://web.example.com', fetcher), true);
});

for (const location of ['/dashboard', 'https://attacker.example/sign-in']) {
  test(`frontend rejects invalid redirect ${location}`, async () => {
    const fetcher = async (url) =>
      url.endsWith('/dashboard')
        ? new Response('', { status: 307, headers: { location } })
        : new Response('Excess <a href="/sign-in">Sign in</a>');
    await assert.rejects(
      smokeWeb('https://web.example.com', fetcher),
      /authentication/,
    );
  });
}

test('provider error or access-protection page is not accepted as a healthy frontend', async () => {
  await assert.rejects(
    smokeWeb(
      'https://web.example.com',
      async () => new Response('Authentication Required'),
    ),
    /landing-page/,
  );
});

test('Clerk development handshake preserves anonymous cookies without leaking them across origins', async () => {
  const origin = 'https://web.example.com';
  const auth = 'https://clerk.example.com';
  let dashboardRequests = 0;
  const fetcher = async (url, options = {}) => {
    if (url === origin)
      return new Response('Excess <a href="/sign-in">Sign in</a>');
    assert.equal(options.headers.Accept, 'text/html');
    if (url.startsWith(auth)) {
      assert.equal(options.headers.Cookie, '');
      return new Response('', {
        status: 307,
        headers: {
          location: `${origin}/dashboard?handshake=temporary`,
          'set-cookie': 'auth_cookie=private; HttpOnly',
        },
      });
    }
    assert.ok(!options.headers.Cookie.includes('auth_cookie'));
    if (url.includes('/dashboard') && dashboardRequests++ === 0) {
      return new Response('', {
        status: 307,
        headers: {
          location: `${auth}/v1/client/handshake`,
          'set-cookie': 'web_cookie=private; HttpOnly',
        },
      });
    }
    assert.equal(options.headers.Cookie, 'web_cookie=private');
    if (url.includes('/dashboard'))
      return new Response('', {
        status: 307,
        headers: { location: '/sign-in' },
      });
    return new Response('Sign in');
  };
  assert.equal(await smokeWeb(origin, fetcher, auth), true);
});

test('a public dashboard or an endless handshake is rejected, not mistaken for a sign-in redirect', async () => {
  const origin = 'https://web.example.com';
  await assert.rejects(
    smokeWeb(
      origin,
      async (url) =>
        new Response(
          url === origin
            ? 'Excess <a href="/sign-in">Sign in</a>'
            : 'Private dashboard',
        ),
    ),
    /authentication redirect/,
  );
  await assert.rejects(
    smokeWeb(origin, async (url) =>
      url === origin
        ? new Response('Excess <a href="/sign-in">Sign in</a>')
        : new Response('', {
            status: 307,
            headers: { location: '/dashboard' },
          }),
    ),
    /redirect loop/,
  );
});
