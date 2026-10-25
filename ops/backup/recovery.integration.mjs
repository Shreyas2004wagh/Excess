import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { createBackup, fileDigest, repositoryRoot } from './backup.mjs';
import { pgBinary, psqlArgs, sourceEnvironment } from './database.mjs';
import { decryptManifest, restoreDrill } from './drill.mjs';
import { run } from './process.mjs';

test(
  'encrypted backup and isolated PostgreSQL restore with the real committed schema',
  { timeout: 240000 },
  async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), 'excess-recovery-fixture-'));
    const owner = randomUUID();
    const name = `excess-backup-test-${owner}`;
    let started = false;
    try {
      await run(
        'docker',
        [
          'run',
          '--detach',
          '--name',
          name,
          '--label',
          `excess.backup-test-owner=${owner}`,
          '--publish',
          '127.0.0.1::5432',
          '--memory',
          '512m',
          '--pids-limit',
          '256',
          '--tmpfs',
          '/var/lib/postgresql/data:rw,nosuid,nodev,size=268435456',
          '--env',
          'POSTGRES_USER=fixture',
          '--env',
          'POSTGRES_DB=fixture',
          '--env',
          `POSTGRES_PASSWORD=${owner}`,
          'postgres:17-alpine',
        ],
        { label: 'Synthetic fixture startup', timeout: 120000 },
      );
      started = true;
      const inspect = JSON.parse(await run('docker', ['inspect', name]));
      const port = inspect[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
      const url = `postgresql://fixture:${owner}@127.0.0.1:${port}/fixture`;
      const writableEnv = {
        ...sourceEnvironment(url),
        PGOPTIONS: '-c timezone=UTC -c client_encoding=UTF8',
      };
      const writeQuery = (sql) =>
        run(pgBinary('psql'), psqlArgs, {
          env: writableEnv,
          input: sql,
          label: 'Synthetic fixture SQL',
        });
      let ready = false;
      for (let attempt = 0; attempt < 120; attempt++) {
        try {
          await writeQuery('SELECT 1;');
          ready = true;
          break;
        } catch {
          await sleep(500);
        }
      }
      assert.ok(ready, 'synthetic PostgreSQL should become ready');

      await writeQuery(`CREATE TABLE public._prisma_migrations (
      id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL,
      finished_at timestamptz, migration_name varchar(255) NOT NULL,
      logs text, rolled_back_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(),
      applied_steps_count integer NOT NULL DEFAULT 0
    );`);
      const migrationsRoot = join(
        repositoryRoot,
        'packages/database/prisma/migrations',
      );
      for (const migration of (await readdir(migrationsRoot))
        .filter((name) => /^\d+_/.test(name))
        .sort()) {
        const sql = await readFile(
          join(migrationsRoot, migration, 'migration.sql'),
          'utf8',
        );
        await writeQuery(sql);
        await writeQuery(
          `INSERT INTO public._prisma_migrations (id,checksum,finished_at,migration_name,applied_steps_count) VALUES ('${randomUUID()}','${createHash('sha256').update(sql).digest('hex')}',now(),'${migration}',1);`,
        );
      }
      const user = randomUUID(),
        account = randomUUID(),
        instrument = randomUUID();
      const position = randomUUID(),
        order = randomUUID(),
        event = randomUUID();
      await writeQuery(`
      BEGIN;
      INSERT INTO public."User" (id,"clerkId",email,"displayName","updatedAt") VALUES ('${user}','recovery-fixture','recovery-fixture@example.invalid',E'Recovery\\nfixture ☃',now());
      INSERT INTO public."Account" (id,"userId",balance,"initialBalance","updatedAt") VALUES ('${account}','${user}',9999.8765432100,10000,now());
      INSERT INTO public."LedgerEntry" (id,"accountId",type,amount,"balanceAfter","idempotencyKey") VALUES
        ('${randomUUID()}','${account}','DEMO_CREDIT',10000,10000,'opening-fixture'),
        ('${randomUUID()}','${account}','FEE',-0.1234567900,9999.8765432100,'fee-fixture');
      INSERT INTO public."Instrument" (id,symbol,"baseCurrency","quoteCurrency","pricePrecision","quantityPrecision","tickSize","lotSize","minimumQuantity","updatedAt") VALUES ('${instrument}','BTC-USD','BTC','USD',2,8,0.01,0.00000001,0.00001,now());
      INSERT INTO public."Position" (id,"accountId","instrumentId","signedQuantity","averageEntryPrice",leverage,"updatedAt") VALUES ('${position}','${account}','${instrument}',-0.0001234500,61000.1234567890,5,now());
      INSERT INTO public."Order" (id,"accountId","instrumentId","clientOrderId",side,type,quantity,status,"executedQuantity","updatedAt") VALUES ('${order}','${account}','${instrument}','fixture-order','SELL','MARKET',0.0001234500,'FILLED',0.0001234500,now());
      INSERT INTO public."Trade" (id,"orderId","accountId","instrumentId","positionId",side,price,quantity,fee) VALUES ('${randomUUID()}','${order}','${account}','${instrument}','${position}','SELL',61000.1234567890,0.0001234500,0.1234567900);
      INSERT INTO public."PriceAlert" (id,"userId","instrumentId",direction,"targetPrice","updatedAt") VALUES ('${randomUUID()}','${user}','${instrument}','ABOVE',70000,now());
      INSERT INTO public."OutboxEvent" (id,"aggregateType","aggregateId","eventType",payload,status) VALUES ('${event}','Account','${account}','fixture','{"synthetic":true}','PUBLISHED');
      INSERT INTO public."Notification" (id,"userId","outboxEventId",type,title,message) VALUES ('${randomUUID()}','${user}','${event}','fixture','Recovery fixture',E'Unicode ☃\\nnewline');
      INSERT INTO public."AuditEvent" (id,"actorUserId",action,"resourceType",metadata) VALUES ('${randomUUID()}','${user}','FIXTURE','Account','{"synthetic":true}');
      COMMIT;
    `);
      const identity = join(temporary, 'fixture.agekey');
      await run('age-keygen', ['--output', identity]);
      const recipient = (await run('age-keygen', ['-y', identity])).trim();
      let backup;
      await t.test(
        'one consistent snapshot despite concurrent committed financial writes',
        async () => {
          backup = await createBackup({
            url,
            recipient,
            outputRoot: join(temporary, 'output'),
            afterFingerprint: async () => {
              await writeQuery(`BEGIN;
          UPDATE public."Account" SET balance=balance+7.0000000001 WHERE id='${account}';
          INSERT INTO public."LedgerEntry" (id,"accountId",type,amount,"balanceAfter") VALUES ('${randomUUID()}','${account}','ADJUSTMENT',7.0000000001,10006.8765432101);
          INSERT INTO public."User" (id,"clerkId",email,"updatedAt") VALUES ('${randomUUID()}','late-fixture','late-fixture@example.invalid',now());
          COMMIT;`);
            },
          });
          assert.equal(backup.tables, 12);
          const manifest = await decryptManifest(backup.directory, identity);
          assert.equal(
            manifest.fingerprint.tables.find((table) => table.name === 'User')
              .rows,
            1,
          );
          assert.equal(
            manifest.fingerprint.tables.find(
              (table) => table.name === 'LedgerEntry',
            ).rows,
            2,
          );
          assert.equal(
            manifest.fingerprint.tables.find(
              (table) => table.name === '_prisma_migrations',
            ).rows,
            8,
          );
          assert.equal(
            (
              await writeQuery(
                `SELECT balance::text FROM public."Account" WHERE id='${account}';`,
              )
            ).trim(),
            '10006.8765432101',
          );
          for (const file of ['database.dump.age', 'manifest.json.age']) {
            assert.equal(
              (await stat(join(backup.directory, file))).mode & 0o777,
              0o600,
            );
            const contents = await readFile(join(backup.directory, file));
            assert.equal(
              contents.subarray(0, 22).toString(),
              'age-encryption.org/v1\n',
            );
            assert.ok(
              !contents.includes(
                Buffer.from('recovery-fixture@example.invalid'),
              ),
            );
            assert.ok(!contents.includes(Buffer.from('AGE-SECRET-KEY-1')));
          }
          const result = await restoreDrill({
            directory: backup.directory,
            identity,
          });
          assert.equal(result.status, 'verified');
          assert.equal(result.tables, 12);
        },
      );

      await t.test('wrong private key cannot decrypt', async () => {
        const wrong = join(temporary, 'wrong.agekey');
        await run('age-keygen', ['--output', wrong]);
        await assert.rejects(
          restoreDrill({ directory: backup.directory, identity: wrong }),
        );
      });

      await t.test(
        'authentication failure is reported safely and removes partial output',
        async () => {
          const root = join(temporary, 'authentication-failure');
          const invalid = new URL(url);
          invalid.password = 'wrong-synthetic-password';
          await assert.rejects(
            createBackup({ url: invalid.href, recipient, outputRoot: root }),
            /Snapshot session failed/,
          );
          assert.deepEqual(await readdir(root), []);
        },
      );

      await t.test(
        'missing completion marker and damaged ciphertext are rejected',
        async () => {
          const copy = join(temporary, 'damaged');
          await cp(backup.directory, copy, { recursive: true });
          await rm(join(copy, 'COMPLETE'));
          await assert.rejects(restoreDrill({ directory: copy, identity }));
          await writeFile(join(copy, 'COMPLETE'), `${backup.id}\n`);
          const path = join(copy, 'database.dump.age');
          const data = await readFile(path);
          await writeFile(path, data.subarray(0, 100));
          await assert.rejects(
            restoreDrill({ directory: copy, identity }),
            /checksum mismatch/,
          );
          data[data.length - 1] ^= 1;
          await writeFile(path, data);
          await assert.rejects(
            restoreDrill({ directory: copy, identity }),
            /checksum mismatch/,
          );
          // Even replacing the manifest digest cannot bypass age authentication.
          const manifest = await decryptManifest(backup.directory, identity);
          manifest.encryptedDump = await fileDigest(path);
          await run('age', ['--encrypt', '--recipient', recipient], {
            input: JSON.stringify(manifest),
            destination: createWriteStream(join(copy, 'manifest.json.age'), {
              mode: 0o600,
            }),
          });
          await assert.rejects(
            restoreDrill({ directory: copy, identity }),
            /Dump decryption failed/,
          );
        },
      );

      await t.test(
        'fingerprint mismatch fails the actual restore and cleans its database',
        async () => {
          const copy = join(temporary, 'mismatched');
          await cp(backup.directory, copy, { recursive: true });
          const manifest = await decryptManifest(backup.directory, identity);
          manifest.fingerprint.tables.find(
            (table) => table.name === 'Account',
          ).sha256 = '0'.repeat(64);
          await run('age', ['--encrypt', '--recipient', recipient], {
            input: JSON.stringify(manifest),
            destination: createWriteStream(join(copy, 'manifest.json.age'), {
              mode: 0o600,
            }),
          });
          await assert.rejects(
            restoreDrill({ directory: copy, identity }),
            /does not match/,
          );
          const containers = await run('docker', [
            'container',
            'ls',
            '--all',
            '--filter',
            'label=excess.restore-owner',
            '--format',
            '{{.Names}}',
          ]);
          assert.equal(containers.trim(), '');
        },
      );

      await t.test(
        'failed export has no completed or partial backup directory',
        async () => {
          const root = join(temporary, 'failed-output');
          await assert.rejects(
            createBackup({
              url,
              recipient,
              outputRoot: root,
              afterFingerprint() {
                throw new Error('Injected failure');
              },
            }),
          );
          assert.deepEqual(await readdir(root), []);
        },
      );

      await t.test(
        'source queries are read-only and financial reconciliation failures prevent success',
        async () => {
          await assert.rejects(
            run(pgBinary('psql'), psqlArgs, {
              env: sourceEnvironment(url),
              input: 'DELETE FROM public."LedgerEntry";',
              label: 'Read-only guard',
            }),
          );
          await writeQuery(
            `UPDATE public."Account" SET balance=0 WHERE id='${account}';`,
          );
          const root = join(temporary, 'unreconciled');
          await assert.rejects(
            createBackup({ url, recipient, outputRoot: root }),
            /reconciliation/,
          );
          assert.deepEqual(await readdir(root), []);
        },
      );
    } finally {
      try {
        if (started) {
          const inspect = JSON.parse(await run('docker', ['inspect', name]));
          assert.equal(
            inspect[0].Config.Labels['excess.backup-test-owner'],
            owner,
          );
          await run('docker', ['rm', '--force', '--volumes', name]);
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  },
);
