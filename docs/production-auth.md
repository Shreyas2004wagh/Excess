# Production authentication cutover

The current hosted app intentionally uses a Clerk development instance. No custom domain has been selected, so do not replace the working demo keys yet. Nothing in this guide authorizes buying a domain or plan, creating OAuth credentials, or resetting accounts.

## Prerequisites controlled by the owner

1. Choose an owned domain and obtain access to its DNS. Configure the frontend domain on Vercel first and verify TLS. Clerk production requires a domain you control.
2. Create a production instance in the existing Clerk application, review its email/password settings, and add the exact DNS records Clerk supplies. Do not guess record targets. Wait for Clerk's certificate/domain checks to complete.
3. Create your own Google OAuth credentials and configure the production Google connection using Clerk's documented redirect URI. Shared development OAuth credentials cannot be reused in production. The owner should enter secrets directly into Clerk, never into chat or Git.
4. Configure a production Clerk webhook endpoint at `https://excess-demo-api.onrender.com/api/v1/webhooks/clerk` (or the chosen verified API domain), subscribing to `user.updated` and `user.deleted`. Copy its real signing secret directly into Render's secret settings. A correctly formatted placeholder is not proof that this subscription works.

## Preserve data and isolate environments

Development and production Clerk instances have distinct users and IDs. Production sign-in does not automatically adopt an old development user's internal account. Keep historical users, accounts, trades, and ledger entries. Never relink accounts by email alone, reset balances, or delete records to make a cutover succeed. Any explicit identity migration needs its own reviewed mapping and backup plan.

Keep GitHub's Clerk testing keys and dedicated E2E identity on the development instance. CI uses its own temporary PostgreSQL/Redis services. Do not replace CI test credentials with production credentials and never run the fixture-cleanup Playwright suite against the hosted database.

## Configuration and deployment

Pause automatic releases and capture both current hosting deployment IDs before cutover. Do not cancel an active release or recovery.

On Render, configure:

- `CLERK_ENVIRONMENT=production`.
- `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` from the same production instance.
- `CLERK_WEBHOOK_SIGNING_SECRET` from that instance's actual endpoint.
- `WEB_ORIGIN` as the exact public HTTPS frontend origin, without a path.

On Vercel's production environment, configure the matching `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`, keeping the existing sign-in/up and dashboard redirect paths. Rebuild: the publishable key is embedded in the frontend build. Do not mix a live frontend with a development API identity authority.

Update `ops/release/config.json` origins and the allowed Clerk origin, plus any affected hosting/auth allowlists. The NestJS verifier already limits `authorizedParties` to `WEB_ORIGIN`. Review the frontend's middleware/CSP against Clerk's current production guidance before deploying the new domain. Do not weaken authentication or allow arbitrary redirect origins to make staging pass.

The API rejects mismatched key environments and inconsistent publishable keys. Opt-in production authentication additionally requires live-key prefixes, a public HTTPS origin, and a webhook signing-secret format. These checks cannot verify DNS, Google consent configuration, or actual webhook delivery; verify those in the providers.

## Verification and recovery

1. Sign in with a dedicated new production identity using email/password and Google. Verify the protected dashboard, token authorization, session refresh, sign-out, and sign-in again.
2. Verify provisioning is idempotent and monetary history persists. Use only the dedicated demo account; do not reset another user's data.
3. Send a signed Clerk test delivery to check transport/signature verification. Invalid signatures must fail. Verify actual update/deletion behavior with a dedicated disposable identity; deleting it must suspend its internal user while preserving financial records. Webhook processing must never grant administrator rights from an unverified primary email.
4. Run hosted read-only health/auth checks and review redacted logs. Confirm both hosts use the same production instance before reenabling automated releases.
5. If cutover fails, restore the saved compatible frontend/API pair and their identity configuration. Review webhook endpoint/subscription settings separately: application rollback does not undo provider-side OAuth, DNS, webhook, or user changes. Do not restore older migration-applying startup artifacts.

References: [Clerk production deployment](https://clerk.com/docs/guides/development/deployment/production), [Google connection setup](https://clerk.com/docs/guides/configure/auth-strategies/social-connections/google), [Clerk webhook synchronization](https://clerk.com/docs/guides/development/webhooks/syncing).
