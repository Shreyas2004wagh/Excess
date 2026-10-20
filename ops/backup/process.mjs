import { spawn } from 'node:child_process';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const children = new Set();
let interrupted = false;

export function assertNotInterrupted() {
  if (interrupted) throw new Error('Recovery operation interrupted');
}

export function interruptTools() {
  interrupted = true;
  for (const child of children) child.kill('SIGKILL');
}

// Never inherit provider tokens, libpq overrides, psql startup files, or a
// caller's PGOPTIONS. Credentials are passed only to the source PG children.
export function toolEnvironment() {
  return Object.fromEntries(
    ['PATH', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'TMPDIR', 'HOME']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
}

export function start(
  command,
  args,
  {
    env = toolEnvironment(),
    label = 'Tool',
    timeout = 600000,
    allowInterrupted = false,
  } = {},
) {
  if (!allowInterrupted) assertNotInterrupted();
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  // stderr can contain connection strings, SQL values and identity material.
  // Deliberately discard it rather than attempting incomplete redaction.
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  const done = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error(`${label} could not start`)));
    child.once('close', (code) => {
      children.delete(child);
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(`${label} failed; sensitive tool output was suppressed`),
        );
    });
  });
  // A pipeline may observe an error before the caller awaits process exit.
  done.catch(() => {});
  return { child, done };
}

export async function run(
  command,
  args,
  { input = '', consume, destination, maxBytes = 1048576, ...options } = {},
) {
  const task = start(command, args, options);
  const chunks = [];
  let size = 0;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (consume) {
        try {
          consume(chunk);
          callback();
        } catch (error) {
          callback(error);
        }
      } else {
        size += chunk.length;
        if (size > maxBytes)
          callback(new Error('Tool output exceeded the safety limit'));
        else {
          chunks.push(chunk);
          callback();
        }
      }
    },
  });
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes)
        callback(new Error('Tool output exceeded the safety limit'));
      else callback(null, chunk);
    },
  });
  try {
    const feeding =
      typeof input === 'string' || Buffer.isBuffer(input)
        ? (task.child.stdin.end(input), Promise.resolve())
        : pipeline(input, task.child.stdin);
    await Promise.all([
      feeding,
      destination
        ? pipeline(task.child.stdout, limit, destination)
        : pipeline(task.child.stdout, output),
      task.done,
    ]);
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    if (task.child.exitCode === null) task.child.kill('SIGKILL');
    await task.done.catch(() => {});
  }
}
