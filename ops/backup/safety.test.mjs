import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateRecipient } from './backup.mjs';
import {
  compareFingerprints,
  quoteIdentifier,
  requiredTables,
  snapshotTransaction,
  sourceEnvironment,
  validateInventory,
} from './database.mjs';
import {
  containerArguments,
  readinessArguments,
  removeOwnedContainer,
  validateDockerEndpoint,
  validateIdentity,
  validateManifest,
} from './drill.mjs';
import { run, toolEnvironment } from './process.mjs';

const direct =
  'postgresql://owner:secret@ep-demo.c-4.ap-southeast-1.aws.neon.tech/excess?sslmode=require&schema=public&connection_limit=3&pool_timeout=20';
const recipient =
  'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';

test('direct connection credentials stay out of argv and Prisma-only parameters are stripped', () => {
  const env = sourceEnvironment(direct);
  assert.equal(env.PGUSER, 'owner');
  assert.equal(env.PGPASSWORD, 'secret');
  assert.equal(env.PGDATABASE, 'excess');
  assert.equal(env.PGSSLMODE, 'require');
  assert.match(env.PGOPTIONS, /default_transaction_read_only=on/);
  assert.equal(env.DATABASE_URL, undefined);
});

for (const [description, value] of [
  ['missing URL', undefined],
  ['malformed URL', 'secret'],
  ['wrong protocol', 'https://owner:secret@example.com/db?sslmode=require'],
  ['pooled host', direct.replace('ep-demo.', 'ep-demo-pooler.')],
  ['remote plaintext', direct.replace('sslmode=require', 'sslmode=disable')],
  ['missing TLS', direct.replace('sslmode=require&', '')],
  ['host override', `${direct}&host=evil.example`],
  ['libpq options override', `${direct}&options=secret`],
  ['non-public schema', direct.replace('schema=public', 'schema=other')],
  [
    'dbname connection-string injection',
    direct.replace('/excess?', '/host%3Devil?'),
  ],
  [
    'dbname URI injection',
    direct.replace('/excess?', '/postgresql%3A%2F%2Fevil?'),
  ],
])
  test(`rejects ${description} without exposing the input`, () => {
    assert.throws(
      () => sourceEnvironment(value),
      (error) =>
        !error.message.includes('secret') &&
        error.message.includes('direct PostgreSQL'),
    );
  });

test('localhost fixture does not require TLS', () => {
  assert.equal(
    sourceEnvironment('postgresql://fixture:fixture@127.0.0.1:5432/fixture')
      .PGSSLMODE,
    'disable',
  );
});

test('Neon channel binding is preserved in the libpq environment', () => {
  const env = sourceEnvironment(`${direct}&channel_binding=require`);
  assert.equal(env.PGCHANNELBINDING, 'require');
  assert.equal(env.PGSSLMODE, 'require');
  assert.throws(() =>
    sourceEnvironment(`${direct}&channel_binding=unexpected`),
  );
});

test('encryption supports native public recipients only', () => {
  assert.equal(validateRecipient(recipient), recipient);
  for (const invalid of [
    '',
    undefined,
    'AGE-SECRET-KEY-1SECRET',
    'age1plugin-yubikey-secret',
    'ssh-ed25519 value',
    `${recipient}\n`,
  ])
    assert.throws(() => validateRecipient(invalid));
});

test('snapshot identifiers cannot inject SQL', () => {
  assert.match(snapshotTransaction('00000003-0000001B-1'), /READ ONLY/);
  assert.throws(() => snapshotTransaction("x'; DROP TABLE users; --"));
  assert.equal(quoteIdentifier('x"y'), '"x""y"');
});

test('timeouts and formatting are transaction-local and snapshot import is first', () => {
  const sql = snapshotTransaction('00000003-0000001B-1');
  assert.match(sql, /SET LOCAL statement_timeout = '120000'/);
  assert.match(sql, /SET LOCAL lock_timeout = '5000'/);
  assert.match(sql, /SET LOCAL idle_in_transaction_session_timeout = '600000'/);
  assert.ok(sql.indexOf('SET TRANSACTION SNAPSHOT') < sql.indexOf('SET LOCAL'));
  assert.equal(
    sourceEnvironment(direct).PGOPTIONS,
    '-c default_transaction_read_only=on',
  );
});

test('inventory requires all core financial tables, history, supported version and schema', () => {
  const valid = {
    postgresMajor: 17,
    extraSchemas: 0,
    unsupportedRelations: 0,
    tables: requiredTables,
  };
  validateInventory(valid);
  for (const changed of [
    { postgresMajor: 16 },
    { extraSchemas: 1 },
    { unsupportedRelations: 1 },
    { tables: requiredTables.filter((name) => name !== 'LedgerEntry') },
  ])
    assert.throws(() => validateInventory({ ...valid, ...changed }));
});

test('all table rows, decimals, positions and migration hashes must match exactly', () => {
  const expected = {
    tables: [
      { name: 'Account', rows: 1, sha256: 'balance-hash' },
      { name: 'Position', rows: 1, sha256: 'quantity-hash' },
      { name: '_prisma_migrations', rows: 8, sha256: 'history-hash' },
    ],
  };
  compareFingerprints(expected, structuredClone(expected));
  for (const index of [0, 1, 2]) {
    const changed = structuredClone(expected);
    changed.tables[index].sha256 = 'different';
    assert.throws(() => compareFingerprints(expected, changed));
  }
});

function validManifest() {
  return {
    format: 1,
    id: randomUUID(),
    schema: 'public',
    createdAt: new Date().toISOString(),
    snapshotAt: new Date().toISOString(),
    encryptedDump: { bytes: 1024, sha256: 'a'.repeat(64) },
    fingerprint: {
      postgresMajor: 17,
      tables: requiredTables.map((name) => ({
        name,
        rows: 1,
        sha256: 'b'.repeat(64),
      })),
      invariants: {
        invalidMigrations: 0,
        ledgerMismatches: 0,
        openingCreditMismatches: 0,
      },
    },
  };
}

test('manifest rejects incomplete, mixed, failed-reconciliation or unsupported backups', () => {
  const valid = validManifest();
  validateManifest(valid, `${valid.id}\n`);
  assert.throws(() => validateManifest(valid, randomUUID()));
  for (const mutate of [
    (item) => {
      item.format = 2;
    },
    (item) => {
      item.fingerprint.invariants.ledgerMismatches = 1;
    },
    (item) => {
      delete item.fingerprint.invariants.openingCreditMismatches;
    },
    (item) => {
      item.fingerprint.tables.pop();
    },
    (item) => {
      item.encryptedDump.sha256 = 'bad';
    },
    (item) => {
      item.fingerprint.tables.push(item.fingerprint.tables[0]);
    },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.throws(() => validateManifest(invalid, invalid.id));
  }
});

test('restore targets only a capped, disconnected container, with no credentials, ports or host mounts', () => {
  const owner = randomUUID();
  const args = containerArguments(`excess-restore-${owner}`, owner);
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cap-drop'));
  assert.ok(args.includes('--memory'));
  assert.ok(args.includes('--pids-limit'));
  assert.ok(args.includes('--security-opt'));
  for (const forbidden of [
    '--publish',
    '-p',
    '--volume',
    '-v',
    '--mount',
    '--privileged',
    '--env-file',
  ])
    assert.ok(!args.includes(forbidden));
  assert.throws(() => containerArguments('production', owner));
});

test('restore refuses remote Docker daemons and binds to a local Unix socket', () => {
  const contexts = (Host) => [{ Endpoints: { docker: { Host } } }];
  assert.equal(
    validateDockerEndpoint(contexts('unix:///var/run/docker.sock')),
    'unix:///var/run/docker.sock',
  );
  for (const endpoint of [
    'ssh://remote.example',
    'tcp://127.0.0.1:2375',
    'tcp://remote.example:2376',
    undefined,
    'unix://relative',
  ])
    assert.throws(() => validateDockerEndpoint(contexts(endpoint)));
});

test('restore readiness waits for the final TCP server, not the temporary init socket', () => {
  const args = readinessArguments('disposable-fixture');
  assert.ok(args.includes('--host=127.0.0.1'));
  assert.ok(args.includes('--dbname=drill'));
});

test('cleanup rejects an unrelated target before invoking Docker', async () => {
  await assert.rejects(removeOwnedContainer('production', randomUUID()));
  await assert.rejects(
    removeOwnedContainer(`excess-restore-${randomUUID()}`, randomUUID()),
  );
});

test('private keys must be restricted, native identities outside the checkout; no symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'excess-key-safety-'));
  const identity = join(dir, 'test.agekey');
  try {
    await writeFile(
      identity,
      '# synthetic format-only fixture\nAGE-SECRET-KEY-1SYNTHETIC\n',
      { mode: 0o600 },
    );
    await validateIdentity(identity);
    await chmod(identity, 0o644);
    await assert.rejects(validateIdentity(identity));
    await chmod(identity, 0o600);
    await symlink(identity, join(dir, 'link'));
    await assert.rejects(validateIdentity(join(dir, 'link')));
    await writeFile(identity, 'AGE-PLUGIN-SECRET\n');
    await assert.rejects(validateIdentity(identity));
    await assert.rejects(validateIdentity('relative.agekey'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('child tools never inherit database URL, provider tokens or caller PGOPTIONS', () => {
  const env = toolEnvironment();
  for (const name of [
    'DATABASE_URL',
    'PGPASSWORD',
    'PGOPTIONS',
    'RENDER_API_KEY',
    'VERCEL_TOKEN',
    'BACKUP_DATABASE_URL',
  ])
    assert.equal(env[name], undefined);
});

test('failed child process output containing secrets is suppressed', async () => {
  await assert.rejects(
    run(
      process.execPath,
      [
        '-e',
        'process.stderr.write("postgresql://secret; AGE-SECRET-KEY-1SECRET"); process.exit(1)',
      ],
      { label: 'Safe tool' },
    ),
    (error) =>
      !error.message.includes('SECRET') &&
      !error.message.includes('postgresql://'),
  );
});

test('bounded tool output and timeouts fail closed', async () => {
  await assert.rejects(
    run(process.execPath, ['-e', 'process.stdout.write("x".repeat(100))'], {
      maxBytes: 10,
    }),
  );
  await assert.rejects(
    run(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeout: 50 }),
  );
});

test('interrupt stops active tools and prevents new work while permitting explicit cleanup', async () => {
  const module = new URL('./process.mjs', import.meta.url).href;
  await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { run, interruptTools } from ${JSON.stringify(module)};
    const active = run(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    setTimeout(interruptTools, 50);
    await assert.rejects(active);
    await assert.rejects(run(process.execPath, ['-e', 'process.exit(0)']));
    await run(process.execPath, ['-e', 'process.exit(0)'], {allowInterrupted:true});
  `,
    ],
    { timeout: 5000 },
  );
});
