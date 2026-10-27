# Availability monitoring and private HTTP telemetry

Excess has a read-only operational checker, an opt-in hourly GitHub Actions workflow, privacy-safe HTTP completion/error events, and process-local Prometheus counters. The initial hosted mode is **availability-only**, as selected for the demo. No external monitoring account, paid service, public incident issue, database write, trade, reset, restart, deployment, or backup upload is part of a check.

## What is checked

- **API readiness:** `GET /api/v1/health/ready` must return HTTP 200, identify `excess-api`, report `ready`, and mark database, Redis and market data `up`. HTTP 200 with the wrong body is not success.
- **API access boundaries:** anonymous requests to the portfolio and metrics endpoints must return 401. A provider redirect, loading page, or accidental anonymous 200 fails the check.
- **Frontend and dashboard protection:** reuse the release checker to verify the Excess landing page and an anonymous dashboard-to-sign-in flow. Clerk development handshakes are followed only on the approved Clerk origin with a fresh, origin-scoped cookie jar; redirect URLs/cookies are never reported.
- **Optional authenticated error metrics:** disabled in availability-only mode. Enabling it later requires a separate metrics bearer token, not a Clerk identity or hosting-provider token. Availability-only mode ignores even an accidentally supplied metrics secret.

API readiness is attempted at most four times with a 20-second request timeout and 10-second pauses (up to about 110 seconds). Recovery within that budget is reported separately from an immediately ready service. Other API checks use bounded requests; the frontend checker has bounded requests and redirect hops. The hosted job times out after eight minutes. All requests are GETs. Credentialed metrics requests never follow redirects, and response bodies are bounded and discarded rather than published.

The hourly cadence leaves room for Render's intentional free-instance idle sleep; it is not a keep-alive loop. A probe still wakes a sleeping service and consumes hosting/database usage, so review quotas. A slow cold start can produce a genuine failed observation even when a later request recovers. These are sampled checks, **not** a 24/7 uptime guarantee, exact uptime percentage, or proof that every trading operation works.

## HTTP error telemetry

Completion middleware runs before routing, guards and controllers, so counters now include 401/403/429 rejections, unknown routes and unhandled HTTP exceptions. Each request is recorded once even if both `finish` and `close` fire. Client disconnects use an internal 499 observation; unexpected server failures use 500.

HTTP log events contain only a validated request ID, bounded method, **registered route template**, status and duration. They never fall back to a raw path/query and do not include authorization headers, cookies, bodies, email, Clerk user/session IDs, exception messages or stacks. Unknown routes receive the constant `unmatched` label. 5xx events use error severity, 4xx warning, and other completions informational severity. This is an HTTP telemetry policy, not a claim that every existing background-worker logger or external provider log has been audited.

The global HTTP exception filter keeps deliberate `HttpException` status/error contracts, including business validation and market-data-unavailable codes. Unknown exceptions return a generic 500 message with the request ID and are not passed to Nest's default raw exception logger. The ID can be correlated with the `X-Request-Id` header and HTTP event. Do not put secrets into caller-supplied request IDs. WebSocket messages and browser JavaScript exceptions are not captured by this HTTP middleware; no browser error-reporting provider has been configured.

Metrics and health endpoints are marked `Cache-Control: no-store`. Metrics remain protected by the existing independent metrics token in production. Labels use fixed methods and bounded status values; no user, order, URL or request ID becomes a metric label. `excess_process_start_time_seconds` identifies the process incarnation.

## Run a check

The availability-only command requires no token and does not load application dotenv files:

```bash
corepack pnpm monitor:check --availability-only
```

It makes read-only requests to the approved demo origins from the existing release configuration. There is no arbitrary destination argument or URL override. Exit zero means the configured checks passed; a failed check or invalid configuration exits nonzero. A sanitized `monitor-output/monitor-report.json` is generated and excluded from Git, deployment uploads and formatting. It is not a database backup.

## GitHub activation and notifications

The **Operational monitoring** workflow supports manual checks and a schedule at minute 23 of each UTC hour. Scheduled checks are gated by `MONITORING_ENABLED=true`; **committing this workflow does not activate the schedule**. Manual runs are allowed from `main` for verification without activating recurring requests. The workflow is restricted to the exact Excess repository and `main`, has read-only contents/actions permissions, cannot cancel another monitor run, and cannot trigger a deployment.

After reviewing and publishing the changes:

1. Let CI pass and let the normal release workflow deploy the HTTP telemetry changes. Do not bypass a failed CI run or manually force a release.
2. Manually run **Operational monitoring** on `main` with `notification_test=false`. Availability-only is the default when `MONITOR_REQUIRE_METRICS` is absent or `false`; no secret is required.
3. Watch the repository and, in GitHub notification settings under **System → Actions**, choose **On GitHub** and/or **Email**. Optionally select **Only notify for failed workflows**. Delivery depends on your subscription and settings; it is not guaranteed merely by a failed run. No new notification channel is silently created.
4. Manually run with `notification_test=true`. This deliberately fails a clearly labeled **synthetic notification test**, makes no live requests, and proves nothing about actual availability. Confirm that the GitHub notification reaches you. Synthetic reports never become error-rate baselines. Check/test failures do not open public issues or post messages to other systems.
5. Only after the manual check and delivery test, set the repository variable `MONITORING_ENABLED=true`. Leave `MONITOR_REQUIRE_METRICS=false` (or absent) for the agreed availability-only rollout. Set the activation variable to `false` to stop recurring probes.

Every run retains only the sanitized `monitor-report` JSON artifact for 14 days, including failure reports when available, and adds a job summary. Treat artifacts in this public repository as publicly obtainable. The report contains approved check names, fixed reason codes, availability states, timing/attempt metadata and, only when opted in, aggregate process HTTP counters. It never contains raw responses, financial records, identifiers, tokens or cookies. Artifacts are operational evidence, not durable incident storage.

Unhealthy checks fail the workflow and use ordinary GitHub failure notifications. This version does **not** deduplicate prolonged incidents or guarantee recovery messages; notification frequency/settings are controlled by GitHub. Scheduled runs can be delayed or disabled by GitHub inactivity policy. There is no independent stale-monitor alarm or external notification delivery integration, so do not rely on this alone for a production trading service.

## Optional error-rate alerts later

Only when explicitly choosing this coverage:

1. Copy the existing Render `METRICS_BEARER_TOKEN` into the GitHub Actions secret `MONITOR_METRICS_BEARER_TOKEN`. Do not paste it into chat, commit it, put it in a URL, or add broad Render/Vercel tokens to this workflow.
2. Set `MONITOR_REQUIRE_METRICS=true`. A missing/invalid token is then a configuration failure, not a silently successful availability-only run. A wrong token, redirect, malformed metric body or unavailable scrape fails the check.
3. For a local authenticated check, inject the variable through a secret manager/private external environment file and run `node ops/monitor/cli.mjs` without `--availability-only`.

Error alerts require **at least 20 observed HTTP requests** and a **5xx ratio of at least 5%**. With a comparable previous sample from the same process, the report uses counter deltas since that sample. It verifies prior workflow/repository/run provenance before downloading its report. If the process restarted, counters regressed, history is absent/unavailable or the baseline is invalid, the current process lifetime is evaluated and labeled as such. Low traffic is explicitly `skipped/insufficient_traffic`, not a demonstrated zero error rate. The measured request count and window scope are shown in the report.

These are process-local counters: free-instance sleep, crashes or deploys can erase observations before an hourly scrape. They are not a durable ledger of errors, a p95 latency measurement, browser error tracking or a complete historical error rate. The existing protected Prometheus endpoint can support a separately approved collector in the future; none is provisioned here. Do not enable the example high-frequency scrape against the sleeping free demo without reviewing its usage impact.

## Incident response

- For readiness failures, inspect the per-dependency states and Render's service/deploy state. Allow the cold-start budget before declaring an outage. Do not restart a healthy app because an upstream market feed is briefly unavailable; the monitor never changes the provider health-check path.
- For unexpected anonymous access, treat authentication/metrics exposure as a security regression; investigate the exact deployed commit before restoring service.
- For 5xx HTTP events, correlate the request ID and server-registered route, then investigate without copying request bodies, tokens or raw database errors into public artifacts/issues. Check the deployed version, database/Redis availability, and relevant private operational logs.
- For monitor configuration failures, correct the approved target/coverage/secret configuration rather than turning off authentication or TLS. For repeated workflow failures, distinguish stale monitoring, provider outages, deliberate notification tests and actual application incidents.
- Use the existing release recovery runbook for code rollback. Monitoring does not reverse database changes; use the encrypted recovery runbook and explicit operator approval for any real data restoration.

## Verification

```bash
corepack pnpm test:monitor
corepack pnpm test:backup
corepack pnpm test:backup:integration
```

Monitor tests use mocked HTTP responses and temporary synthetic artifacts, not hosted credentials or financial fixtures. API telemetry tests include a real disposable Nest HTTP server to verify unknown exceptions, guard rejection, unmatched paths, request-ID correlation and single-count behavior. The restore integration suite also verifies final TCP readiness, avoiding the image's temporary Unix-socket initialization server; no live restore or financial-record deletion is used to fix a CI failure.

References: [Render free-instance behavior](https://render.com/docs/free), [Render health checks](https://render.com/docs/health-checks), [GitHub Actions notification configuration](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications), and [Nest exception filters](https://docs.nestjs.com/exception-filters).
