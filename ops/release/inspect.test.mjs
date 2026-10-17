import test from 'node:test';
import assert from 'node:assert/strict';
import { describeConnection } from './inspect.mjs';

test('connection inspection exposes only routing booleans, never credentials', () => {
  const result = describeConnection(
    'postgresql://secret-user:secret-password@ep-demo.aws.neon.tech/private-db?sslmode=require&options=endpoint%3Dep-demo-pooler&private-key=hidden',
  );
  assert.deepEqual(result, {
    present: true,
    postgres: true,
    neon: true,
    pooledHostname: false,
    endpointOverride: true,
    pooledEndpointOverride: true,
    pgbouncerMode: false,
    sslRequired: true,
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /secret|hidden|private-db|ep-demo/,
  );
  assert.equal(describeConnection('not-a-url-secret').invalid, true);
  assert.deepEqual(describeConnection(), { present: false });
  assert.equal(
    describeConnection('postgres://u:p@ep-demo-pooler.aws.neon.tech/db')
      .pooledHostname,
    true,
  );
});
