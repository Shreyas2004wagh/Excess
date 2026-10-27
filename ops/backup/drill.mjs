import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  compareFingerprints,
  fingerprintDatabase,
  pgOptions,
  psqlArgs,
  requiredTables,
  snapshotTransaction,
} from './database.mjs';
import { fileDigest, regularFile, repositoryRoot } from './backup.mjs';
import { assertNotInterrupted, run } from './process.mjs';

export const drillImage = 'postgres:17-alpine';

export function readinessArguments(name) {
  return [
    'exec',
    name,
    'pg_isready',
    '--host=127.0.0.1',
    '--username=drill',
    '--dbname=drill',
  ];
}

export function validateDockerEndpoint(contexts) {
  const endpoint =
    contexts?.length === 1 ? contexts[0].Endpoints?.docker?.Host : undefined;
  if (
    typeof endpoint !== 'string' ||
    !endpoint.startsWith('unix:///') ||
    /[\r\n]/.test(endpoint)
  )
    throw new Error(
      'Restore drills require a local Unix-socket Docker endpoint, never a remote Docker daemon',
    );
  return endpoint;
}

export async function localDocker() {
  // Bind every command to an inspected local socket, not a mutable context.
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT)
    throw new Error(
      'Unset DOCKER_HOST and DOCKER_CONTEXT before a local restore drill',
    );
  const contexts = JSON.parse(
    await run('docker', ['context', 'inspect'], {
      label: 'Local Docker endpoint check',
    }),
  );
  const endpoint = validateDockerEndpoint(contexts);
  return (args, options) =>
    run('docker', ['--host', endpoint, ...args], options);
}

export function containerArguments(name, owner) {
  if (
    !/^excess-restore-[0-9a-f-]{36}$/.test(name) ||
    !/^[0-9a-f-]{36}$/.test(owner) ||
    name !== `excess-restore-${owner}`
  )
    throw new Error('Invalid disposable container identity');
  return [
    'run',
    '--detach',
    '--name',
    name,
    '--label',
    `excess.restore-owner=${owner}`,
    '--network',
    'none',
    '--read-only',
    '--user',
    'postgres',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    '1g',
    '--cpus',
    '1',
    '--pids-limit',
    '256',
    '--tmpfs',
    '/var/lib/postgresql/data:rw,nosuid,nodev,noexec,uid=70,gid=70,mode=0700,size=536870912',
    '--tmpfs',
    '/var/run/postgresql:rw,nosuid,nodev,noexec,uid=70,gid=70,mode=0700',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,noexec,size=67108864',
    '--env',
    'POSTGRES_USER=drill',
    '--env',
    'POSTGRES_DB=drill',
    '--env',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    drillImage,
  ];
}

export async function removeOwnedContainer(name, owner, docker) {
  // Apply the same name/owner bounds before even inspecting a removal target.
  containerArguments(name, owner);
  docker ??= await localDocker();
  const inspect = JSON.parse(
    await docker(['inspect', name], {
      label: 'Disposable container inspection',
      allowInterrupted: true,
    }),
  );
  if (
    inspect.length !== 1 ||
    inspect[0].Config?.Labels?.['excess.restore-owner'] !== owner ||
    inspect[0].HostConfig?.NetworkMode !== 'none' ||
    inspect[0].Name !== `/${name}`
  )
    throw new Error(
      'Refusing to remove a container not owned by this restore drill',
    );
  await docker(['rm', '--force', '--volumes', name], {
    label: 'Disposable container cleanup',
    allowInterrupted: true,
  });
}

export async function validateIdentity(path) {
  if (!isAbsolute(path ?? ''))
    throw new Error(
      'BACKUP_AGE_IDENTITY_FILE must be an absolute path outside the repository',
    );
  const stat = await regularFile(path);
  const location = await realpath(path);
  const repo = await realpath(repositoryRoot);
  const within = relative(repo, location);
  const outside =
    within === '..' || within.startsWith('../') || isAbsolute(within);
  if (!outside || (stat.mode & 0o077) !== 0 || stat.size > 4096)
    throw new Error(
      'Keep the private identity outside the repository with mode 0600',
    );
  const lines = (await readFile(path, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'));
  if (lines.length !== 1 || !/^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(lines[0]))
    throw new Error(
      'Only a single native age identity is supported; plugins are not allowed',
    );
}

export function validateManifest(manifest, complete) {
  const fingerprint = manifest?.fingerprint;
  if (
    manifest?.format !== 1 ||
    manifest.schema !== 'public' ||
    manifest.id !== complete.trim() ||
    !/^[0-9a-f-]{36}$/.test(manifest.id) ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !Number.isFinite(Date.parse(manifest.snapshotAt)) ||
    fingerprint?.postgresMajor !== 17 ||
    !Array.isArray(fingerprint.tables) ||
    !requiredTables.every((name) =>
      fingerprint.tables.some((table) => table.name === name),
    ) ||
    new Set(fingerprint.tables.map((table) => table.name)).size !==
      fingerprint.tables.length ||
    fingerprint.tables.some(
      (table) =>
        typeof table.name !== 'string' ||
        !Number.isSafeInteger(table.rows) ||
        table.rows < 0 ||
        !/^[0-9a-f]{64}$/.test(table.sha256),
    ) ||
    !fingerprint.tables.find((table) => table.name === '_prisma_migrations')
      ?.rows ||
    !fingerprint.invariants ||
    Object.keys(fingerprint.invariants).sort().join(',') !==
      'invalidMigrations,ledgerMismatches,openingCreditMismatches' ||
    Object.values(fingerprint.invariants).some((count) => count !== 0) ||
    !/^[0-9a-f]{64}$/.test(manifest.encryptedDump?.sha256) ||
    !Number.isSafeInteger(manifest.encryptedDump?.bytes) ||
    manifest.encryptedDump.bytes < 1
  )
    throw new Error('Invalid or incomplete encrypted backup manifest');
}

export async function decryptManifest(directory, identity) {
  for (const [name, limit] of [
    ['COMPLETE', 128],
    ['manifest.json.age', 2097152],
    ['database.dump.age', 536870912],
  ]) {
    const stat = await regularFile(join(directory, name));
    if (stat.size < 1 || stat.size > limit)
      throw new Error('Backup file exceeds the drill safety limit');
  }
  const complete = await readFile(join(directory, 'COMPLETE'), 'utf8');
  const manifest = JSON.parse(
    await run(
      'age',
      [
        '--decrypt',
        '--identity',
        identity,
        join(directory, 'manifest.json.age'),
      ],
      { label: 'Manifest decryption' },
    ),
  );
  validateManifest(manifest, complete);
  const digest = await fileDigest(join(directory, 'database.dump.age'));
  if (
    digest.sha256 !== manifest.encryptedDump.sha256 ||
    digest.bytes !== manifest.encryptedDump.bytes
  )
    throw new Error('Encrypted dump checksum mismatch');
  return manifest;
}

export async function restoreDrill({ directory, identity } = {}) {
  if (!directory) throw new Error('BACKUP_DIRECTORY is required');
  await validateIdentity(identity);
  directory = resolve(directory);
  const manifest = await decryptManifest(directory, identity);
  const docker = await localDocker();
  const temporary = await mkdtemp(join(tmpdir(), 'excess-restore-'));
  const dump = join(temporary, 'database.dump');
  const owner = randomUUID();
  const name = `excess-restore-${owner}`;
  let attemptedContainer = false;
  try {
    assertNotInterrupted();
    // Authenticate the ENTIRE age payload before executing any archived SQL.
    await run(
      'age',
      [
        '--decrypt',
        '--identity',
        identity,
        join(directory, 'database.dump.age'),
      ],
      {
        label: 'Dump decryption',
        maxBytes: 536870912,
        destination: createWriteStream(dump, { flags: 'wx', mode: 0o600 }),
      },
    );
    attemptedContainer = true;
    await docker(containerArguments(name, owner), {
      label: 'Disposable PostgreSQL startup',
      timeout: 120000,
    });
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        await docker(
          // The image's temporary initialization server listens only on the
          // Unix socket. TCP becomes ready only after initialization finishes.
          readinessArguments(name),
          { label: 'Disposable PostgreSQL readiness', timeout: 5000 },
        );
        ready = true;
        break;
      } catch {
        assertNotInterrupted();
        await sleep(500);
      }
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
    // Only this brand-new, disconnected container is writable. No target URL
    // is accepted anywhere in the restore path, and no source env is inherited.
    await docker(
      [
        'exec',
        name,
        'psql',
        ...psqlArgs,
        '--username=drill',
        '--dbname=drill',
        '--command=DROP SCHEMA public;',
      ],
      { label: 'Prepare empty disposable database' },
    );
    await docker(
      [
        'exec',
        '--interactive',
        name,
        'pg_restore',
        '--username=drill',
        '--dbname=drill',
        '--no-owner',
        '--no-acl',
        '--exit-on-error',
        '--single-transaction',
      ],
      {
        input: createReadStream(dump),
        label: 'Restore into isolated PostgreSQL',
      },
    );
    const query = (sql, options) =>
      docker(
        [
          'exec',
          '--interactive',
          '--env',
          `PGOPTIONS=${pgOptions}`,
          name,
          'psql',
          ...psqlArgs,
          '--username=drill',
          '--dbname=drill',
        ],
        {
          ...options,
          input: `${snapshotTransaction()}${sql}\nROLLBACK;\n`,
          label: 'Restored data verification',
        },
      );
    const actual = await fingerprintDatabase(query);
    compareFingerprints(manifest.fingerprint, actual);
    return {
      id: manifest.id,
      tables: actual.tables.length,
      status: 'verified',
    };
  } finally {
    try {
      if (attemptedContainer) {
        // A lost docker-run response can still mean creation succeeded.
        const existing = await docker(
          [
            'container',
            'ls',
            '--all',
            '--filter',
            `name=^/${name}$`,
            '--format',
            '{{.Names}}',
          ],
          { label: 'Disposable container lookup', allowInterrupted: true },
        );
        if (existing.trim() === name)
          await removeOwnedContainer(name, owner, docker);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
