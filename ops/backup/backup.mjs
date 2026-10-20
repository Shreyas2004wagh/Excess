import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, lstat, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  fingerprintDatabase,
  openSnapshot,
  sourceEnvironment,
  sourceQuery,
  pgBinary,
} from './database.mjs';
import { run, start } from './process.mjs';

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export function validateRecipient(value) {
  // Native X25519 recipients only: no executable plugins or SSH agent access.
  if (!/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(value ?? ''))
    throw new Error(
      'BACKUP_AGE_RECIPIENT must be a native age X25519 public recipient',
    );
  return value;
}

export async function fileDigest(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

export async function regularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Expected a regular file, not a link');
  return stat;
}

async function encryptedDump(env, snapshot, recipient, output) {
  const dump = start(
    pgBinary('pg_dump'),
    [
      '--format=custom',
      '--schema=public',
      '--strict-names',
      '--no-owner',
      '--no-acl',
      '--lock-wait-timeout=5000',
      `--snapshot=${snapshot}`,
      '--no-password',
    ],
    { env, label: 'Database export' },
  );
  const encrypt = start('age', ['--encrypt', '--recipient', recipient], {
    label: 'Backup encryption',
  });
  dump.child.stdin.end();
  try {
    await Promise.all([
      pipeline(dump.child.stdout, encrypt.child.stdin),
      pipeline(
        encrypt.child.stdout,
        createWriteStream(output, { flags: 'wx', mode: 0o600 }),
      ),
      dump.done,
      encrypt.done,
    ]);
  } finally {
    for (const task of [dump, encrypt])
      if (task.child.exitCode === null) task.child.kill('SIGKILL');
    await Promise.allSettled([dump.done, encrypt.done]);
  }
}

export async function createBackup({
  url,
  recipient,
  outputRoot = resolve(repositoryRoot, 'backup-output'),
  afterFingerprint,
} = {}) {
  const env = sourceEnvironment(url);
  validateRecipient(recipient);
  const version = await run(pgBinary('pg_dump'), ['--version']);
  if (!/^pg_dump \(PostgreSQL\) 17\./.test(version))
    throw new Error('PostgreSQL 17 client tools are required');
  await run('age', ['--encrypt', '--recipient', recipient], {
    label: 'Encryption preflight',
  });
  const id = randomUUID();
  // Only remove a unique directory created by this invocation on failure.
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const directory = join(resolve(outputRoot), `excess-backup-${id}`);
  await mkdir(directory, { mode: 0o700 });
  let session;
  let complete = false;
  try {
    session = await openSnapshot(env);
    const fingerprint = await fingerprintDatabase(sourceQuery(env, session.id));
    session.assertAlive();
    // Test seam: a write committed here must not enter the exported snapshot.
    if (afterFingerprint) await afterFingerprint();
    const dump = join(directory, 'database.dump.age');
    await encryptedDump(env, session.id, recipient, dump);
    session.assertAlive();
    const encryptedDumpDigest = await fileDigest(dump);
    const manifest = {
      format: 1,
      id,
      createdAt: new Date().toISOString(),
      snapshotAt: session.at,
      schema: 'public',
      fingerprint,
      encryptedDump: encryptedDumpDigest,
    };
    await run(
      'age',
      [
        '--encrypt',
        '--recipient',
        recipient,
        '--output',
        join(directory, 'manifest.json.age'),
      ],
      {
        input: JSON.stringify(manifest),
        label: 'Manifest encryption',
      },
    );
    await session.close();
    session = undefined;
    await writeFile(join(directory, 'COMPLETE'), `${id}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    complete = true;
    return { directory, id, tables: fingerprint.tables.length };
  } finally {
    session?.abort();
    if (!complete) await rm(directory, { recursive: true, force: true });
  }
}
