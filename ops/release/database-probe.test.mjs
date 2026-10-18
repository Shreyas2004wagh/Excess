import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeConnection,
  probePostgresConnection,
} from './database-probe.mjs';

test('compute diagnostics cannot send credentials to a different endpoint or domain', () => {
  const source = 'postgres://u:p@ep-demo.region.neon.tech/db';
  assert.equal(
    new URL(computeConnection(source, 'ep-demo-zy5.region.neon.tech')).hostname,
    'ep-demo-zy5.region.neon.tech',
  );
  for (const host of [
    'attacker.example',
    'ep-other-zy5.region.neon.tech',
    'ep-demo-zy5.other.neon.tech',
    'ep-demo-pooler.region.neon.tech',
  ]) {
    assert.throws(() => computeConnection(source, host), /same Neon endpoint/);
  }
});

test('standard PostgreSQL probe keeps credentials out of argv and uses the direct host', async () => {
  const result = await probePostgresConnection(
    'postgresql://private-user:private-password@direct.neon.tech/excess?sslmode=require',
    async (session) => {
      assert.equal(session.pid, 42);
      return false;
    },
    async (file, args, options) => {
      assert.equal(file, 'psql');
      assert.doesNotMatch(
        JSON.stringify(args),
        /private-user|private-password|postgresql:/,
      );
      assert.equal(options.env.PGHOST, 'direct.neon.tech');
      assert.equal(options.env.PGPASSWORD, 'private-password');
      assert.equal(options.env.PGSSLMODE, 'require');
      assert.ok(args.includes('-X'));
      return {
        stdout: JSON.stringify({
          pid: 42,
          started: 'now',
          application_name: 'excess-release-diagnostic',
        }),
      };
    },
  );
  assert.deepEqual(result, {
    connected: true,
    applicationNameHonored: true,
    backendRemainsAfterDisconnect: false,
  });
});

test('probe failures do not expose raw child diagnostics or connection values', async () => {
  const result = await probePostgresConnection(
    'postgres://u:secret@host/db',
    async () => false,
    async () => {
      throw new Error('secret URL or stderr');
    },
  );
  assert.deepEqual(result, { connected: false });
});
