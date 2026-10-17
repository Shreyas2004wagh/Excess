import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { jsonRequest } from './platform.mjs';

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
  // Whitelist output fields. Do not log the provider response or URL errors.
  console.log(
    JSON.stringify(
      {
        runtime: describeConnection(variables.get('DATABASE_URL')),
        migration: describeConnection(variables.get('DATABASE_URL_UNPOOLED')),
        schemaEngineOverride: variables.has('PRISMA_SCHEMA_ENGINE_BINARY'),
        pgOptionsOverride: variables.has('PGOPTIONS'),
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
