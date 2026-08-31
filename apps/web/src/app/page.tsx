import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs';
import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-8 sm:px-10">
      <nav className="flex items-center justify-between border-b border-[var(--border)] pb-6">
        <Link
          className="font-mono text-lg font-semibold tracking-[0.18em]"
          href="/"
        >
          EXCESS
        </Link>
        <div className="flex items-center gap-3">
          <Show when="signed-out">
            <SignInButton mode="modal">
              <button className="button button-secondary">Sign in</button>
            </SignInButton>
            <SignUpButton mode="modal" forceRedirectUrl="/dashboard">
              <button className="button button-primary">Create account</button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            <Link className="button button-primary" href="/dashboard">
              Dashboard
            </Link>
            <UserButton />
          </Show>
        </div>
      </nav>

      <section className="flex flex-1 flex-col justify-center py-20">
        <p className="mb-5 font-mono text-sm uppercase tracking-[0.28em] text-[var(--accent)]">
          Paper markets. Real discipline.
        </p>
        <h1 className="max-w-4xl text-5xl font-semibold tracking-[-0.045em] sm:text-7xl">
          Learn the market without paying tuition to it.
        </h1>
        <p className="mt-7 max-w-2xl text-lg leading-8 text-[var(--muted)]">
          Start with $10,000 in virtual funds. Build conviction, test decisions,
          and develop your trading process without risking real money.
        </p>
        <div className="mt-10 flex flex-wrap gap-3">
          <Show when="signed-out">
            <SignUpButton mode="modal" forceRedirectUrl="/dashboard">
              <button className="button button-primary button-large">
                Start with $10,000
              </button>
            </SignUpButton>
            <SignInButton mode="modal">
              <button className="button button-secondary button-large">
                I already have an account
              </button>
            </SignInButton>
          </Show>
          <Show when="signed-in">
            <Link
              className="button button-primary button-large"
              href="/dashboard"
            >
              Open dashboard
            </Link>
          </Show>
        </div>
      </section>
    </main>
  );
}
