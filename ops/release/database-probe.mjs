import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function probePostgresConnection(value, observe, run = exec) {
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol))
      return { connected: false };
    const { stdout } = await run(
      'psql',
      [
        '-X',
        '--no-password',
        '-A',
        '-t',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        'SELECT row_to_json(s) FROM (SELECT pid, backend_start::text AS started, application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()) s',
      ],
      {
        // Avoid URL/credentials in argv, inherited PG overrides, and psqlrc.
        env: {
          PATH: process.env.PATH,
          PGHOST: url.hostname,
          PGPORT: url.port || '5432',
          PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
          PGUSER: decodeURIComponent(url.username),
          PGPASSWORD: decodeURIComponent(url.password),
          PGSSLMODE: url.searchParams.get('sslmode') || 'require',
          PGCONNECT_TIMEOUT: '15',
          PGAPPNAME: 'excess-release-diagnostic',
          PGOPTIONS: url.searchParams.get('options') || '',
        },
        timeout: 30000,
        maxBuffer: 16384,
      },
    );
    const session = JSON.parse(stdout.trim());
    return {
      connected: true,
      applicationNameHonored:
        session.application_name === 'excess-release-diagnostic',
      backendRemainsAfterDisconnect: await observe(session),
    };
  } catch {
    // Child errors include argv/stderr; never forward them or connection data.
    return { connected: false };
  }
}
