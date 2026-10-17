import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const exec = promisify(execFile);
const active = new Set([
  'created',
  'queued',
  'build_in_progress',
  'pre_deploy_in_progress',
  'update_in_progress',
]);

export async function poll(
  check,
  { attempts = 80, delay = 15000, wait = sleep } = {},
) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      if (error.fatal) throw error;
      lastError = error;
    }
    if (attempt + 1 < attempts) await wait(delay);
  }
  throw new Error('Timed out waiting for deployment/health check', {
    cause: lastError,
  });
}

export async function jsonRequest(url, token, body, fetcher = fetch) {
  // No redirect-following on credentialed calls, and no automatic POST retry:
  // a timeout can mean a deployment was accepted but its response was lost.
  const response = await fetcher(url, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    // Provider bodies may include credentials/configuration; never log them.
    const error = new Error(
      `Provider request failed (HTTP ${response.status})`,
    );
    error.fatal =
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 429;
    throw error;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export async function smokeApi(origin, fetcher = fetch) {
  const response = await fetcher(`${origin}/api/v1/health/ready`, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  if (
    response.status !== 200 ||
    body.service !== 'excess-api' ||
    body.status !== 'ready' ||
    ['database', 'redis', 'marketData'].some(
      (key) => body.checks?.[key] !== 'up',
    )
  ) {
    throw new Error('API readiness failed');
  }
  const protectedResponse = await fetcher(
    `${origin}/api/v1/trading/portfolio`,
    { redirect: 'manual', signal: AbortSignal.timeout(15000) },
  );
  if (protectedResponse.status !== 401)
    throw new Error('API authentication protection failed');
  return true;
}

export async function smokeWeb(origin, fetcher = fetch, clerkOrigin) {
  const home = await fetcher(origin, {
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });
  const html = await home.text();
  if (
    home.status !== 200 ||
    !html.includes('Excess') ||
    !html.includes('href="/sign-in"')
  )
    throw new Error('Frontend landing-page check failed');
  // Clerk development instances handshake first. Use a fresh, anonymous jar,
  // never the CI user's session; keep cookies isolated by exact origin and
  // never log locations (the handshake query contains short-lived tokens).
  const cookies = new Map();
  let url = new URL('/dashboard', origin);
  for (let hop = 0; hop < 8; hop++) {
    const ownOrigin = url.origin === new URL(origin).origin;
    if (
      !ownOrigin &&
      (url.origin !== clerkOrigin || url.pathname !== '/v1/client/handshake')
    )
      throw new Error(
        'Frontend redirected to an unapproved authentication origin',
      );
    const jar = cookies.get(url.origin) ?? new Map();
    const response = await fetcher(url.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
      headers: {
        Accept: 'text/html',
        Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
      },
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const separator = pair.indexOf('=');
      if (separator > 0)
        jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    cookies.set(url.origin, jar);
    const redirect = response.headers.get('location');
    await response.body?.cancel();
    if (ownOrigin && url.pathname === '/sign-in' && response.status === 200)
      return true;
    if (![302, 303, 307, 308].includes(response.status) || !redirect)
      throw new Error('Frontend authentication redirect failed');
    url = new URL(redirect, url);
  }
  throw new Error('Frontend authentication redirect loop');
}

export function createPlatform(
  config,
  env = process.env,
  { fetcher = fetch, run = exec, wait = sleep } = {},
) {
  for (const name of [
    'RENDER_API_KEY',
    'VERCEL_TOKEN',
    'GH_TOKEN',
    'GITHUB_REPOSITORY',
  ]) {
    if (!env[name])
      throw new Error(
        `Missing required release credential/configuration: ${name}`,
      );
  }
  if (env.GITHUB_REPOSITORY !== config.repository)
    throw new Error('Release configuration belongs to a different repository');
  const renderPath = `/services/${config.renderServiceId}`;
  const render = (path, body) =>
    jsonRequest(
      `https://api.render.com/v1${path}`,
      env.RENDER_API_KEY,
      body,
      fetcher,
    );
  const vercel = (path, body) =>
    jsonRequest(
      `https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}teamId=${config.vercelOrgId}`,
      env.VERCEL_TOKEN,
      body,
      fetcher,
    );
  const github = (path) =>
    jsonRequest(
      `https://api.github.com/repos/${config.repository}${path}`,
      env.GH_TOKEN,
      undefined,
      fetcher,
    );
  async function command(args) {
    try {
      const { stdout } = await run(
        'pnpm',
        ['dlx', 'vercel@64.0.2', ...args, '--token', env.VERCEL_TOKEN],
        {
          env: {
            ...env,
            // CI already has exact, verified IDs. --scope unnecessarily calls
            // /v2/user, which can fail for otherwise valid team-scoped tokens.
            VERCEL_ORG_ID: config.vercelOrgId,
            VERCEL_PROJECT_ID: config.vercelProjectId,
            NO_COLOR: '1',
          },
          timeout: 20 * 60 * 1000,
          maxBuffer: 5 * 1024 * 1024,
        },
      );
      return stdout;
    } catch (error) {
      // execFile's default error includes argv (and therefore the token).
      // Retain bounded stderr diagnostics, never error.message/argv or stdout
      // (deployment JSON may contain environment configuration).
      let detail = String(error.stderr ?? error.code ?? 'unknown CLI error');
      for (const [name, value] of Object.entries(env)) {
        if (/TOKEN|SECRET|PASSWORD|KEY/.test(name) && value?.length >= 4) {
          detail = detail.replaceAll(value, '[redacted]');
        }
      }
      detail = detail.trim().split('\n').slice(-6).join('\n').slice(-1500);
      throw new Error(`Vercel ${args[0]} failed: ${detail}`);
    }
  }
  async function apiDeploys() {
    return (await render(`${renderPath}/deploys?limit=100`)).map(
      (item) => item.deploy,
    );
  }
  async function current() {
    const deployments = await apiDeploys();
    if (deployments.some((item) => active.has(item.status)))
      throw new Error(
        'Render has an in-progress deployment; retry after it finishes',
      );
    const api = deployments.find((item) => item.status === 'live');
    const alias = await vercel(
      `/v4/aliases/${new URL(config.webOrigin).hostname}`,
    );
    if (
      !api?.commit?.id ||
      alias.projectId !== config.vercelProjectId ||
      !alias.deploymentId
    )
      throw new Error('Cannot resolve the existing production deployments');
    return {
      api: { id: api.id, sha: api.commit.id },
      web: { id: alias.deploymentId, url: `https://${alias.deployment.url}` },
    };
  }
  async function inspectWeb(id) {
    const deployment = await vercel(
      `/v13/deployments/${encodeURIComponent(id)}`,
    );
    if (
      deployment.id !== id ||
      deployment.projectId !== config.vercelProjectId ||
      deployment.readyState !== 'READY' ||
      deployment.target !== 'production'
    )
      throw new Error(
        'Vercel deployment is not a ready production build of Excess',
      );
    return deployment;
  }
  const platform = {
    async isLatest(sha) {
      return (await github('/git/ref/heads/main')).object.sha === sha;
    },
    async preflight() {
      const service = await render(renderPath);
      if (
        service.repo?.replace(/\.git$/, '') !==
          `https://github.com/${config.repository}` ||
        service.branch !== 'main' ||
        service.ownerId !== config.renderOwnerId ||
        service.autoDeploy !== 'no' ||
        service.serviceDetails?.url !== config.apiOrigin
      )
        throw new Error(
          'Render service/repository mismatch or provider auto-deploy is enabled',
        );
      const project = await vercel(`/v9/projects/${config.vercelProjectId}`);
      if (project.id !== config.vercelProjectId || project.link)
        throw new Error(
          'Vercel project mismatch or competing Git auto-deployment is enabled',
        );
    },
    current,
    async assertCurrent(expected) {
      const actual = await current();
      if (
        actual.api.id !== expected.api.id ||
        actual.web.id !== expected.web.id
      )
        throw new Error(
          'Production changed outside this release; refusing to overwrite it',
        );
    },
    async checkDatabaseCompatibility(from, to) {
      if (!/^[a-f0-9]{40}$/.test(from) || !/^[a-f0-9]{40}$/.test(to))
        throw new Error('Invalid release commit');
      const { stdout } = await run('git', [
        'diff',
        '--name-only',
        from,
        to,
        '--',
        'packages/database/prisma',
      ]);
      if (stdout.trim())
        throw new Error(
          'Database schema/migrations changed: review compatibility and release manually; automatic database rollback is not supported',
        );
    },
    async stageWeb(sha) {
      // CLI JSON envelopes vary between CI/agent modes. Resolve the build by
      // a unique tag through the provider API, not stdout or a shared "latest".
      const attempt = randomUUID();
      await command([
        'deploy',
        '--prod',
        '--skip-domain',
        '--yes',
        '--format',
        'json',
        '--meta',
        `githubCommitSha=${sha}`,
        '--meta',
        `excessReleaseAttempt=${attempt}`,
      ]);
      const listed = await vercel(
        `/v6/deployments?projectId=${config.vercelProjectId}&limit=20`,
      );
      const matches = listed.deployments.filter(
        (deployment) => deployment.meta?.excessReleaseAttempt === attempt,
      );
      if (matches.length !== 1 || !matches[0].uid)
        throw new Error(
          'Cannot uniquely identify the staged Vercel deployment',
        );
      const verified = await inspectWeb(matches[0].uid);
      if (
        verified.meta?.githubCommitSha !== sha ||
        verified.meta?.excessReleaseAttempt !== attempt
      )
        throw new Error('Vercel build commit did not match the tested commit');
      return { id: verified.id, url: `https://${verified.url}` };
    },
    async deployApi(sha) {
      const result = await render(`${renderPath}/deploys`, {
        commitId: sha,
        clearCache: 'do_not_clear',
      });
      if (!result.id) throw new Error('Render did not return a deployment ID');
      return { id: result.id, sha };
    },
    async waitApi(id, sha) {
      await poll(
        async () => {
          const result = await render(
            `${renderPath}/deploys/${encodeURIComponent(id)}`,
          );
          if (!active.has(result.status) && result.status !== 'live') {
            const error = new Error(
              `Render deployment ended with ${result.status}`,
            );
            error.fatal = true;
            throw error;
          }
          if (result.status !== 'live') return false;
          if (result.commit?.id !== sha) {
            const error = new Error('Render deployed the wrong commit');
            error.fatal = true;
            throw error;
          }
          return true;
        },
        { wait },
      );
    },
    async settleApi(id) {
      const deployments = await apiDeploys();
      const pending = deployments.filter((item) => active.has(item.status));
      if (pending.some((item) => item.id !== id))
        throw new Error(
          'Another Render deploy is pending; recovery requires operator review',
        );
      if (!pending.length) return;
      await render(
        `${renderPath}/deploys/${encodeURIComponent(id)}/cancel`,
        {},
      );
      await poll(
        async () =>
          !active.has(
            (await render(`${renderPath}/deploys/${encodeURIComponent(id)}`))
              .status,
          ),
        { attempts: 12, wait },
      );
    },
    async promoteWeb(id) {
      await inspectWeb(id);
      await vercel(
        `/v10/projects/${config.vercelProjectId}/promote/${encodeURIComponent(id)}`,
        {},
      );
      await poll(
        async () =>
          (await vercel(`/v4/aliases/${new URL(config.webOrigin).hostname}`))
            .deploymentId === id,
        { attempts: 18, delay: 10000, wait },
      );
    },
    async rollbackWeb(id) {
      await inspectWeb(id);
      await vercel(
        `/v1/projects/${config.vercelProjectId}/rollback/${encodeURIComponent(id)}`,
        {},
      );
      await poll(
        async () =>
          (await vercel(`/v4/aliases/${new URL(config.webOrigin).hostname}`))
            .deploymentId === id,
        { attempts: 18, delay: 10000, wait },
      );
    },
    async rollbackApi(id) {
      const result = await render(`${renderPath}/rollback`, { deployId: id });
      if (!result.id)
        throw new Error('Render did not return a rollback deployment ID');
      return { id: result.id };
    },
    smokeApi: () =>
      poll(() => smokeApi(config.apiOrigin, fetcher), {
        attempts: 12,
        delay: 10000,
        wait,
      }),
    smokeWeb: (origin) =>
      poll(() => smokeWeb(origin, fetcher, config.clerkOrigin), {
        attempts: 6,
        delay: 10000,
        wait,
      }),
    async smoke() {
      await platform.smokeApi();
      await platform.smokeWeb(config.webOrigin);
    },
  };
  return platform;
}
