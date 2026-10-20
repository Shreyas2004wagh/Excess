import { appendFile } from 'node:fs/promises';
import { createBackup } from './backup.mjs';
import { restoreDrill } from './drill.mjs';
import { interruptTools } from './process.mjs';

const mode = process.argv[2];
let successful = false;
process.once('SIGINT', interruptTools);
process.once('SIGTERM', interruptTools);
try {
  if (process.argv.length !== 3)
    throw new Error('Use environment variables, not credential arguments');
  if (mode === 'create') {
    const result = await createBackup({
      url: process.env.BACKUP_DATABASE_URL,
      recipient: process.env.BACKUP_AGE_RECIPIENT,
      outputRoot: process.env.BACKUP_OUTPUT_ROOT,
    });
    console.log(
      `Encrypted backup complete: ${result.id} (${result.tables} tables)`,
    );
    // A directory is intentionally not emitted as a GitHub command or output:
    // caller-controlled paths must not inject workflow directives.
  } else if (mode === 'drill') {
    if (process.env.BACKUP_RESTORE_ACK !== 'ISOLATED_LOCAL_CONTAINER')
      throw new Error('Explicit isolated-restore acknowledgement is required');
    const result = await restoreDrill({
      directory: process.env.BACKUP_DIRECTORY,
      identity: process.env.BACKUP_AGE_IDENTITY_FILE,
    });
    console.log(
      `Restore drill verified: ${result.id} (${result.tables} tables). Disposable database removed.`,
    );
  } else throw new Error('Expected create or drill mode');
  successful = true;
} catch {
  // Never print underlying filesystem, SQL, URI or age errors: even parsing
  // exceptions can include a private manifest or credential-bearing input.
  console.error(
    'Database recovery operation failed. Check prerequisites, configuration, permissions and the recovery runbook. Sensitive diagnostic output was suppressed.',
  );
  process.exitCode = 1;
} finally {
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Database backup/recovery\n\n${successful ? 'Operation completed.' : 'Operation failed: no backup/recovery success claimed.'}\n\nOnly encrypted database/manifest files may be retained. A successful export is not a restore-drill result.\n`,
    );
  }
}
