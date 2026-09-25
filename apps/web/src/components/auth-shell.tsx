import type { ReactNode } from 'react';
import { Brand } from './brand';
import { Icon } from './icon';

export function AuthLoading() {
  return (
    <div className="panel w-full max-w-[400px] p-8" aria-busy="true">
      <p className="eyebrow" role="status">
        Loading secure sign-in…
      </p>
      <div className="skeleton mt-7 h-12" />
      <div className="skeleton mt-5 h-12" />
      <div className="skeleton mt-8 h-11" />
    </div>
  );
}

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="auth-page">
      <section className="auth-story">
        <Brand />
        <div>
          <p className="eyebrow">YOUR NEXT CHAPTER</p>
          <h1>
            Real markets.
            <br />
            Room to learn.
          </h1>
          <p className="max-w-sm text-sm leading-7 text-[var(--muted)]">
            A focused workspace to explore your ideas, understand your risk, and
            find your rhythm.
          </p>
          <div className="mt-8 flex items-center gap-3 text-sm">
            <Icon name="wallet" />
            <span>$10,000 in virtual funds. Yours to practice with.</span>
          </div>
        </div>
        <p className="text-xs text-[var(--muted)]">
          Paper trading only. No real money at risk.
        </p>
      </section>
      <section className="auth-form" aria-label="Account authentication">
        <Brand />
        {children}
        <p className="text-center text-xs text-[var(--muted)]">
          Your identity is secured by Clerk.
        </p>
      </section>
    </main>
  );
}
