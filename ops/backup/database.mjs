import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { run, start, toolEnvironment } from './process.mjs';

export const requiredTables = [
  'Account',
  'AuditEvent',
  'Instrument',
  'LedgerEntry',
  'Notification',
  'Order',
  'OutboxEvent',
  'Position',
  'PriceAlert',
  'Trade',
  'User',
  '_prisma_migrations',
];
// Some managed proxies reject timeout GUCs in the startup packet. Keep the
// read-only default enforced there, and scope all other settings to the SQL
// transaction below; never fall back to a writable source connection.
export const pgOptions = '-c default_transaction_read_only=on';
const transactionSettings = `SET LOCAL statement_timeout = '120000';
SET LOCAL lock_timeout = '5000';
SET LOCAL idle_in_transaction_session_timeout = '600000';
SET LOCAL timezone = 'UTC';
SET LOCAL datestyle = 'ISO';
SET LOCAL extra_float_digits = 3;
SET LOCAL bytea_output = 'hex';
SET LOCAL client_encoding = 'UTF8';\n`;
export const psqlArgs = [
  '--no-psqlrc',
  '--quiet',
  '--tuples-only',
  '--no-align',
  '--no-password',
  '--set=ON_ERROR_STOP=1',
];

export function sourceEnvironment(value) {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const allowed = new Set([
      'sslmode',
      'connect_timeout',
      'schema',
      'connection_limit',
      'pool_timeout',
      'channel_binding',
    ]);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.hash ||
      !url.username ||
      !url.hostname ||
      !url.pathname.slice(1) ||
      !/^[a-zA-Z0-9.:[\]-]+$/.test(url.hostname) ||
      url.hostname.split('.')[0].endsWith('-pooler') ||
      [...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
      (url.searchParams.has('schema') &&
        url.searchParams.get('schema') !== 'public') ||
      (url.searchParams.has('channel_binding') &&
        !['require', 'prefer', 'disable'].includes(
          url.searchParams.get('channel_binding'),
        )) ||
      (!local &&
        !['require', 'verify-full'].includes(url.searchParams.get('sslmode')))
    )
      throw new Error();
    const fields = {
      PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    };
    if (
      ![fields.PGUSER, fields.PGDATABASE].every((item) =>
        /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(item),
      )
    )
      throw new Error();
    if (
      Object.values(fields).some((item) =>
        [...item].some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
      )
    )
      throw new Error();
    return {
      ...toolEnvironment(),
      ...fields,
      PGSSLMODE: url.searchParams.get('sslmode') || 'disable',
      PGCONNECT_TIMEOUT: '15',
      ...(url.searchParams.has('channel_binding')
        ? { PGCHANNELBINDING: url.searchParams.get('channel_binding') }
        : {}),
      PGAPPNAME: 'excess-encrypted-backup',
      PGOPTIONS: pgOptions,
    };
  } catch {
    throw new Error(
      'BACKUP_DATABASE_URL must be an explicit direct PostgreSQL URL; remote sources require TLS and only documented connection parameters are accepted',
    );
  }
}

export function pgBinary(name, directory = process.env.BACKUP_PG_BIN_DIR) {
  return directory ? join(directory, name) : name;
}

export function snapshotTransaction(snapshot) {
  if (snapshot && !/^[0-9A-F]+-[0-9A-F]+-\d+$/i.test(snapshot))
    throw new Error('Invalid snapshot identifier');
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n${snapshot ? `SET TRANSACTION SNAPSHOT '${snapshot}';\n` : ''}${transactionSettings}`;
}

export async function openSnapshot(env) {
  const task = start(pgBinary('psql'), psqlArgs, {
    env,
    label: 'Snapshot session',
  });
  const lines = createInterface({ input: task.child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  task.child.stdin.write(
    `${snapshotTransaction()}SELECT json_build_object('id', pg_export_snapshot(), 'at', transaction_timestamp());\n`,
  );
  try {
    const result = await Promise.race([
      iterator.next(),
      task.done.then(() => {
        throw new Error('Snapshot session ended early');
      }),
    ]);
    if (result.done) {
      // Preserve the sanitized connection failure, not JSON.parse(undefined).
      await task.done;
      throw new Error('Snapshot session ended before exporting metadata');
    }
    const snapshot = JSON.parse(result.value);
    const id = snapshot.id;
    if (
      result.done ||
      !/^[0-9A-F]+-[0-9A-F]+-\d+$/i.test(id) ||
      !Number.isFinite(Date.parse(snapshot.at))
    )
      throw new Error('Snapshot export failed');
    return {
      id,
      at: new Date(snapshot.at).toISOString(),
      assertAlive() {
        if (task.child.exitCode !== null || task.child.signalCode !== null)
          throw new Error('Snapshot session was lost');
      },
      async close() {
        task.child.stdin.end('ROLLBACK;\n');
        await task.done;
        lines.close();
      },
      abort() {
        task.child.kill('SIGKILL');
        lines.close();
      },
    };
  } catch (error) {
    task.child.kill('SIGKILL');
    lines.close();
    await task.done.catch(() => {});
    throw error;
  }
}

export function sourceQuery(env, snapshot) {
  return (sql, options) =>
    run(pgBinary('psql'), psqlArgs, {
      ...options,
      env,
      label: 'Read-only source verification',
      input: `${snapshotTransaction(snapshot)}${sql}\nROLLBACK;\n`,
    });
}

export function quoteIdentifier(value) {
  if (typeof value !== 'string' || !value || value.includes('\0'))
    throw new Error('Invalid table identifier');
  return `"${value.replaceAll('"', '""')}"`;
}

export const inventorySql = `SELECT json_build_object(
  'postgresMajor', current_setting('server_version_num')::int / 10000,
  'extraSchemas', (SELECT count(*)::int FROM pg_namespace WHERE nspname <> 'public' AND nspname <> 'information_schema' AND nspname !~ '^pg_'),
  'unsupportedRelations', (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('p','f','m')),
  'tables', (SELECT coalesce(json_agg(c.relname ORDER BY c.relname COLLATE "C"), '[]'::json) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r')
);`;

export const invariantsSql = `SELECT json_build_object(
  'invalidMigrations', (SELECT count(*)::int FROM public._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL),
  'ledgerMismatches', (SELECT count(*)::int FROM public."Account" a WHERE a.balance <> coalesce((SELECT sum(l.amount) FROM public."LedgerEntry" l WHERE l."accountId"=a.id), 0)),
  'openingCreditMismatches', (SELECT count(*)::int FROM public."Account" a WHERE a.type='DEMO' AND ((SELECT count(*) FROM public."LedgerEntry" l WHERE l."accountId"=a.id AND l.type='DEMO_CREDIT') <> 1 OR (SELECT sum(l.amount) FROM public."LedgerEntry" l WHERE l."accountId"=a.id AND l.type='DEMO_CREDIT') IS DISTINCT FROM a."initialBalance"))
);`;

export function validateInventory(inventory) {
  if (
    inventory.postgresMajor !== 17 ||
    inventory.extraSchemas !== 0 ||
    inventory.unsupportedRelations !== 0 ||
    !Array.isArray(inventory.tables) ||
    !requiredTables.every((name) => inventory.tables.includes(name))
  )
    throw new Error(
      'Expected PostgreSQL 17 public application schema, migration history and core financial tables',
    );
}

export async function fingerprintDatabase(query) {
  const inventory = JSON.parse(await query(inventorySql));
  validateInventory(inventory);
  const tables = [];
  for (const name of inventory.tables) {
    const hash = createHash('sha256');
    let rows = 0;
    // COPY text escapes embedded newlines, so each output newline is one row.
    // C collation and UTC/ISO settings keep the stream stable across hosts.
    await query(
      `COPY (SELECT row_to_json(t)::text FROM public.${quoteIdentifier(name)} t ORDER BY row_to_json(t)::text COLLATE "C") TO STDOUT;`,
      {
        consume(chunk) {
          hash.update(chunk);
          for (const byte of chunk) if (byte === 10) rows++;
        },
      },
    );
    tables.push({ name, rows, sha256: hash.digest('hex') });
  }
  if (!tables.find((table) => table.name === '_prisma_migrations')?.rows)
    throw new Error('Migration history is empty');
  const invariants = JSON.parse(await query(invariantsSql));
  if (Object.values(invariants).some((count) => count !== 0))
    throw new Error('Financial reconciliation or migration validation failed');
  return { postgresMajor: inventory.postgresMajor, tables, invariants };
}

export function compareFingerprints(expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error('Restored data does not match the backup snapshot');
}
