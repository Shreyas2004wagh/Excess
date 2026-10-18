import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { jsonRequest } from './platform.mjs';
import {
  computeConnection,
  probePostgresConnection,
} from './database-probe.mjs';

export function describeConnection(value) {
  if (!value) return { present: false };
  try {
    const url = new URL(value);
    const options = url.searchParams.get('options') ?? '';
    return {
      present: true,
      postgres: ['postgres:', 'postgresql:'].includes(url.protocol),
      neon: url.hostname.endsWith('.neon.tech'),
      pooledHostname: url.hostname.includes('-pooler.'),
      // A libpq endpoint override can change routing despite a direct host.
      endpointOverride: /endpoint[=\s]/i.test(options),
      pooledEndpointOverride: /endpoint[=\s][^\s]*-pooler/i.test(options),
      pgbouncerMode: url.searchParams.get('pgbouncer') === 'true',
      sslRequired: ['require', 'verify-full', 'verify-ca'].includes(
        url.searchParams.get('sslmode'),
      ),
    };
  } catch {
    return { present: true, invalid: true };
  }
}

async function inspect() {
  const config = JSON.parse(
    await readFile(new URL('./config.json', import.meta.url), 'utf8'),
  );
  if (
    process.env.GITHUB_REPOSITORY !== config.repository ||
    !process.env.RENDER_API_KEY
  )
    throw new Error('Missing inspection credentials or repository mismatch');
  const values = await jsonRequest(
    `https://api.render.com/v1/services/${config.renderServiceId}/env-vars?limit=100`,
    process.env.RENDER_API_KEY,
  );
  const variables = new Map(
    values.map(({ envVar }) => [envVar.key, envVar.value]),
  );
  const require = createRequire(
    new URL('../../packages/database/package.json', import.meta.url),
  );
  const { PrismaClient } = require('@prisma/client');
  async function probe(key) {
    const url = variables.get(key);
    if (!url) return { present: false };
    const client = new PrismaClient({ datasourceUrl: url, log: [] });
    const observer = new PrismaClient({
      datasourceUrl: variables.get('DATABASE_URL'),
      log: [],
    });
    try {
      const [session] = await client.$queryRawUnsafe(
        'SELECT pid, backend_start::text AS started, application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()',
      );
      await client.$disconnect();
      // Unlike application_name, backend lifetime checks session continuity.
      // Match the start timestamp too, so a reused PID is not misidentified.
      const [after] = await observer.$queryRawUnsafe(
        'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1::int AND backend_start = $2::timestamptz) AS remains',
        session.pid,
        session.started,
      );
      return {
        connected: true,
        applicationNameIsPgBouncer: session?.application_name === 'pgbouncer',
        backendRemainsAfterDisconnect: after.remains,
      };
    } catch {
      return { connected: false };
    } finally {
      await client.$disconnect();
      await observer.$disconnect();
    }
  }
  async function wireProbe(value = variables.get('DATABASE_URL_UNPOOLED')) {
    const observer = new PrismaClient({
      datasourceUrl: variables.get('DATABASE_URL'),
      log: [],
    });
    try {
      return await probePostgresConnection(value, async (session) => {
        const [after] = await observer.$queryRawUnsafe(
          'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1::int AND backend_start = $2::timestamptz) AS remains',
          session.pid,
          session.started,
        );
        return after.remains;
      });
    } finally {
      await observer.$disconnect();
    }
  }
  // Whitelist output fields. Do not log the provider response or URL errors.
  console.log(
    JSON.stringify(
      {
        runtime: describeConnection(variables.get('DATABASE_URL')),
        migration: describeConnection(variables.get('DATABASE_URL_UNPOOLED')),
        schemaEngineOverride: variables.has('PRISMA_SCHEMA_ENGINE_BINARY'),
        pgOptionsOverride: variables.has('PGOPTIONS'),
        runtimeProbe: await probe('DATABASE_URL'),
        migrationProbe: await probe('DATABASE_URL_UNPOOLED'),
        standardPostgresMigrationProbe: await wireProbe(),
        ...(process.env.DIAGNOSTIC_COMPUTE_HOST
          ? {
              standardPostgresComputeProbe: await wireProbe(
                computeConnection(
                  variables.get('DATABASE_URL_UNPOOLED'),
                  process.env.DIAGNOSTIC_COMPUTE_HOST,
                ),
              ),
            }
          : {}),
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  inspect().catch(() => {
    console.error('Read-only configuration inspection failed; values withheld');
    process.exitCode = 1;
  });
}
