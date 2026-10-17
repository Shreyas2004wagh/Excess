# Releases and recovery

## One-time activation

The workflow reuses the existing free Render service and Vercel project. It does not create infrastructure, change plans, or reset financial records. It is opt-in and remains inactive until configured and merged to `main`.

1. In [Render Account Settings](https://dashboard.render.com/u/settings), create an API key named `Excess GitHub Actions`. Render displays the full key only once. Store it as the GitHub Actions repository secret **`RENDER_API_KEY`**.
2. In [Vercel Access Tokens](https://vercel.com/account/tokens), create a token scoped to the team that owns Excess (`shreyas2004waghs-projects`). Store it as **`VERCEL_TOKEN`**. Use an expiry you can renew; expired/revoked keys stop releases before deployment.
3. Add both under [Excess → Settings → Secrets and variables → Actions → Secrets](https://github.com/Shreyas2004wagh/Excess/settings/secrets/actions), not in `.env`, source files, chat, or workflow YAML. Restrict account/team access as much as the providers allow: these credentials can mutate hosting resources.
4. Keep Render **Auto-Deploy Off** and Vercel's Git integration disconnected. The workflow verifies these settings to prevent an independent deploy bypassing CI or racing recovery.
5. Under Actions **Variables**, set **`RELEASE_AUTOMATION_ENABLED`** to **`true`**. This activates releases for subsequent successful push CI runs on `main`. Set it to `false` to pause automatic releases; manual recovery remains available.
6. Merge/push the reviewed changes only with the repository owner's approval. The Release workflow must exist on the default branch before GitHub can trigger it. Check the first full CI/Release run and both hosting dashboards.

Non-secret project IDs and origins live in `ops/release/config.json`, including the exact Clerk origin allowed during the anonymous development handshake. Update that origin when changing Clerk instances. Forks must change that file and the repository allowlist in the workflow before enabling releases. Hosting environment secrets (Clerk, database, Redis) remain configured at the providers and are not copied into GitHub.

## Successful release

`CI` still runs on pull requests and pushes. The independent **Release** workflow accepts only a successful `CI` run originating from a push to this repository's `main`; pull requests, forks, failed/cancelled CI, and stale commits cannot deploy. CI continues to test the full application, and now tests the release state machine too.

The release job uses read-only GitHub permissions and the `production` environment. Its concurrency lock is separate from CI's cancel-on-new-push lock: new CI runs cannot interrupt an active release or rollback. Avoid simultaneous manual provider deployments.

1. Check out the exact CI-tested SHA. Verify that it is still the tip of `main`, provider/project identities match, no competing Render deployment exists, and current hosted health/auth protection pass.
2. Refuse changes under `packages/database/prisma` compared with the live API commit. Database-changing releases need a manually reviewed compatibility/backup plan; they are not silently marked rollback-safe.
3. Save the current Render deploy ID/commit and the Vercel deployment serving the public alias, before any deployment changes.
4. Build the frontend remotely with the pinned Vercel CLI, production environment, and `--skip-domain`. Verify its commit metadata, readiness, landing page, and anonymous dashboard redirect without moving the public URL.
5. Recheck `main` and current deployments. Deploy Render with the exact tested commit, wait for its deploy to become `live`, verify its commit, and check database/Redis/feed readiness and unauthenticated API protection.
6. Promote the staged Vercel deployment. Verify both active deployment IDs and run hosted checks again before recording `released`.

Hosted checks are read-only: no test account deletion, trade placement, account resets, database fixture insertion, or production load testing. Authenticated trading flows remain covered by the isolated CI Playwright suite. These probes do not claim to test every feature in production.

## Failure and rollback checks

The job attempts recovery after a failed release but stays red even if recovery succeeds. Its summary and **`release-state`** artifact distinguish `released`, `skipped`, `rolled-back`, and `rollback-failed`; the checkpoint contains deployment IDs, not credentials, and is retained for 30 days.

Recovery first settles/cancels an owned in-flight Render deploy, then verifies neither live target was replaced by an unrelated/later deploy. It restores the saved frontend when necessary and asks Render to roll back to its saved build artifact. It waits for the new rollback deploy, verifies the restored API commit and frontend ID, and repeats hosted health/auth checks. A failed recovery of one target does not suppress the attempt/checks for the other. Ambiguous/lost deployment responses fail closed rather than blindly replaying a POST or overwriting an unknown deployment.

To recover a completed release later:

1. Pause automatic releases by setting `RELEASE_AUTOMATION_ENABLED=false` and let any active release finish. Do not cancel an active release during a provider mutation.
2. In [GitHub Actions → Release](https://github.com/Shreyas2004wagh/Excess/actions/workflows/release.yml), find the run that changed the live versions. Copy its numeric **Release run ID**, not its CI run ID; the number is at the end of its run URL.
3. Choose **Run workflow**, select **main**, and enter that run ID. The job validates the run and artifact, verifies ownership of both current deployments, restores the saved versions, and checks them. A stale artifact cannot overwrite a newer release.
4. Check the recovery summary/artifact, Render deploy status, and the [hosted demo](https://excess-psi.vercel.app). If a recovery was interrupted, use its newer Release run artifact when retrying so the new rollback deployment ID is recognized.
5. Fix/revert the faulty code through the normal review/CI process before reenabling automatic releases. Recovery changes hosting, not the `main` branch.

If GitHub cannot run the job or an API response was lost, inspect the IDs in the checkpoint and both provider dashboards before manually cancelling/redeploying anything. Never retry an unknown POST blindly. If provider auto-deploy was enabled externally, disable it before recovery. Missing/expired artifacts or unavailable provider builds require operator intervention, not a database reset or an unreviewed rebuild fallback.

## Limits

- This coordinates two hosts, not an atomic cross-provider transaction. Keep API changes compatible with the previously deployed frontend during the cutover.
- Rollback restores application builds, **not** migrations, ledger entries, trades, notifications, external writes, or all provider settings. Never run down-migrations against the hosted database as part of recovery.
- Render rollback depends on retained build artifacts. Vercel Hobby rollback is limited to the previous production deployment; this job saves exactly that target. Old checkpoints are not a promise of unlimited historical rollback.
- Provider/network outages may prevent both deployment and recovery. The workflow reports failure and preserves the checkpoint; it does not promise uninterrupted availability on free hosting.
- Hard cancellation/runner loss can interrupt checkpoint writes or provider operations. The artifact upload is best-effort, not guaranteed after a terminated runner. Provider dashboards remain the recovery source of truth.

Run `corepack pnpm test:release` for deterministic tests of stale-run rejection, deploy ordering, readiness/auth failures, rollback verification/failures, replay safety, and bounded polling. No cloud credentials are required for these tests.

## Migration-lock incident checks

The manual **Inspect release configuration** workflow reads the existing Render environment configuration and performs a read-only session query through each database URL. It reports only routing booleans and connection outcomes, never URLs, credentials, or provider response bodies. The `applicationNameIsPgBouncer` flag describes the session's application name; it is a diagnostic clue, not by itself proof of routing mode.

If Prisma reports `P1002` while acquiring advisory lock `72707369`, pause automatic releases first. Inspect `pg_locks` joined to `pg_stat_activity` for that exact granted advisory lock. Revalidate the holder's PID, backend start timestamp, database, idle state, and absence of an active transaction before requesting permission to disconnect only that session. Do not reset the database, disable advisory locking, terminate all connections, or put recurring session termination into CI.

A successful deployment does not establish that the lock problem is fixed. Check for a leftover lock after migration startup and confirm both the configured direct URL and actual connection behavior. If it recurs despite a direct hostname, preserve the healthy deployment and keep automation paused while investigating with the database provider. Do not assume clearing a session permanently fixes the underlying cause.

References: [Render deploy lifecycle](https://render.com/docs/deploys), [Render rollbacks](https://render.com/docs/rollbacks), [Vercel staged production deployments](https://vercel.com/docs/cli/deploy#skip-domain), [Vercel rollback limits](https://vercel.com/docs/cli/rollback), and [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
