import { Show, UserButton } from '@clerk/nextjs';
import Link from 'next/link';

import { Brand } from '../components/brand';
import { Icon } from '../components/icon';
import { TerminalPreview } from '../components/terminal-preview';

function StartAction() {
  return (
    <>
      <Show when="signed-out">
        <Link className="button button-primary button-large" href="/sign-up">
          Start with $10,000 <Icon name="arrow" />
        </Link>
      </Show>
      <Show when="signed-in">
        <Link className="button button-primary button-large" href="/dashboard">
          Open dashboard <Icon name="arrow" />
        </Link>
      </Show>
    </>
  );
}

export default function HomePage() {
  return (
    <div className="landing">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="landing-nav">
        <Brand />
        <nav aria-label="Explore Excess" className="landing-links">
          <a href="#workspace">The workspace</a>
          <a href="#how-it-works">How it works</a>
        </nav>
        <div className="flex items-center gap-2">
          <Show when="signed-out">
            <Link className="button button-quiet" href="/sign-in">
              Sign in
            </Link>
            <Link className="button button-secondary" href="/sign-up">
              Create account <Icon name="diagonal" size={15} />
            </Link>
          </Show>
          <Show when="signed-in">
            <Link className="button button-secondary" href="/dashboard">
              Dashboard <Icon name="arrow" size={15} />
            </Link>
            <UserButton />
          </Show>
        </div>
      </header>
      <main id="main-content" tabIndex={-1}>
        <section className="landing-hero">
          <div>
            <p className="eyebrow flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />{' '}
              THE PRACTICE ADVANTAGE
            </p>
            <h1>
              Make your
              <br />
              next move
              <br />
              <em>a better one.</em>
            </h1>
            <p className="hero-description">
              Real markets. Virtual money. A focused place to test your ideas,
              understand your risk, and build a trading process that’s yours.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <StartAction />
              <a className="button button-quiet" href="#workspace">
                Explore the workspace <Icon name="diagonal" size={16} />
              </a>
            </div>
            <p className="hero-proof">
              <Icon name="shield" size={14} /> No deposit. No real money at
              risk.
            </p>
          </div>
          <TerminalPreview />
        </section>
        <section aria-label="The essentials" className="feature-strip">
          <article>
            <strong>$10,000 to begin</strong>
            <p>Your own virtual USD account.</p>
          </article>
          <article>
            <strong>BTC + ETH markets</strong>
            <p>Live prices. Simulated executions.</p>
          </article>
          <article>
            <strong>A clearer feedback loop</strong>
            <p>Every trade, tracked and reviewable.</p>
          </article>
        </section>
        <section className="landing-section" id="workspace">
          <p className="eyebrow">ONE WORKSPACE. YOUR PROCESS.</p>
          <h2>Everything you need to practice with intention.</h2>
          <div className="feature-grid">
            <article className="panel feature-card">
              <Icon name="terminal" size={24} />
              <h3>See the market clearly.</h3>
              <p>
                Live candlesticks, a focused watchlist, and market, limit, and
                stop orders. Less hunting for controls. More time with your
                setup.
              </p>
            </article>
            <article className="panel feature-card">
              <Icon name="shield" size={24} />
              <h3>Get to know your risk.</h3>
              <p>
                Explore leverage with visible margin requirements, stop-loss and
                take-profit protection, and real-time position P/L.
              </p>
            </article>
            <article className="panel feature-card">
              <Icon name="reports" size={24} />
              <h3>Turn trades into lessons.</h3>
              <p>
                Review daily realized results, filter your execution history,
                and export your data. Build on what the numbers actually tell
                you.
              </p>
            </article>
          </div>
        </section>
        <section className="landing-section" id="how-it-works">
          <p className="eyebrow">FROM FIRST IDEA TO FIRST INSIGHT</p>
          <h2>
            A little less guessing.
            <br />A lot more practice.
          </h2>
          <div className="feature-grid">
            {[
              [
                '01',
                'Make it your workspace.',
                'Create an account and start with a $10,000 virtual balance. No funding or deposits needed.',
              ],
              [
                '02',
                'Put your thesis to the test.',
                'Choose BTC or ETH, define an order, and watch your position respond to the market.',
              ],
              [
                '03',
                'Review. Refine. Repeat.',
                'See what happened, understand the result, and bring that perspective to your next trade.',
              ],
            ].map(([number, title, description]) => (
              <article
                key={number}
                className="feature-card border-t border-[var(--border)]"
              >
                <span className="eyebrow">{number} /</span>
                <h3>{title}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="landing-section">
          <div className="landing-cta">
            <div>
              <h2>Your process starts here.</h2>
              <p className="mt-3 text-sm text-[var(--muted)]">
                Give your next idea somewhere to grow.
              </p>
            </div>
            <StartAction />
          </div>
        </section>
      </main>
      <footer className="landing-footer">
        <span>© Excess · The practice advantage.</span>
        <span>Paper trading only. No real funds or exchange orders.</span>
      </footer>
    </div>
  );
}
