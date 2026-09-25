import { auth } from '@clerk/nextjs/server';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Icon } from '../../components/icon';
import { PageState } from '../../components/page-state';
import { WorkspaceShell } from '../../components/workspace-shell';
import {
  bootstrapSession,
  ExcessApiError,
  getLedger,
  getMarketInstruments,
  getPortfolio,
} from '../../lib/excess-api';
import {
  formatCurrency,
  formatDate,
  ledgerLabel,
  formatSignedCurrency,
} from '../../lib/format';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const session = await auth();
  if (!session.userId) redirect('/sign-in');
  const token = await session.getToken();
  if (!token) redirect('/sign-in');

  try {
    const { user, account } = await bootstrapSession(token);
    const [ledger, marketResult, portfolioResult] = await Promise.all([
      getLedger(token),
      getMarketInstruments(token)
        .then((value) => ({ value }))
        .catch(() => ({ value: null })),
      getPortfolio(token)
        .then((value) => ({ value }))
        .catch(() => ({ value: null })),
    ]);
    const portfolio = portfolioResult.value;
    const markets = marketResult.value?.items;
    return (
      <WorkspaceShell active="dashboard" admin={user.role === 'ADMIN'}>
        <header className="page-heading">
          <div>
            <p className="eyebrow">YOUR PRACTICE, IN PERSPECTIVE</p>
            <h1>
              Welcome
              {user.displayName
                ? `, ${user.displayName.split(' ')[0]}`
                : ' back'}
              .
            </h1>
            <p className="description">
              A clear view of your account. A little space for your next idea.
            </p>
          </div>
          <Link className="button button-primary" href="/terminal">
            Open terminal <Icon name="arrow" size={16} />
          </Link>
        </header>
        <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
          <article className="panel balance-panel">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm text-[var(--muted)]">
                <Icon name="wallet" size={17} />
                Virtual balance
              </span>
              <span className="demo-label">{account.status}</span>
            </div>
            <p className="balance-number" data-testid="dashboard-balance">
              {formatCurrency(account.balance, account.baseCurrency)}
            </p>
            <p className="text-xs text-[var(--muted)]">
              Available cash in your demo account · {account.baseCurrency}
            </p>
            <div className="relative z-10 mt-8 flex flex-wrap justify-between gap-4 border-t border-white/10 pt-5 text-xs">
              <div>
                <p className="text-[var(--muted)]">Account holder</p>
                <p className="mt-2">{user.displayName ?? 'Demo trader'}</p>
              </div>
              <div>
                <p className="text-[var(--muted)]">Member since</p>
                <p className="mt-2">{formatDate(account.createdAt)}</p>
              </div>
              <span className="self-end text-[var(--accent)]">
                Virtual funds. Real practice.
              </span>
            </div>
          </article>
          <article className="panel">
            <div className="panel-heading">
              <h2>Markets at a glance</h2>
              <span className="text-[10px] text-[var(--muted)]">
                PRICE SNAPSHOT
              </span>
            </div>
            {markets ? (
              <div className="divide-y divide-[var(--border)]">
                {markets.map((instrument) => (
                  <div
                    key={instrument.symbol}
                    className="flex items-center justify-between gap-3 px-5 py-5"
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`asset-avatar ${instrument.baseCurrency === 'ETH' ? 'eth' : ''}`}
                      >
                        {instrument.baseCurrency === 'BTC' ? '₿' : 'Ξ'}
                      </span>
                      <div>
                        <p className="text-sm font-medium">
                          {instrument.baseCurrency === 'BTC'
                            ? 'Bitcoin'
                            : 'Ethereum'}
                        </p>
                        <p className="mt-1 font-mono text-[10px] text-[var(--muted)]">
                          {instrument.symbol}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-mono text-sm">
                        {formatCurrency(instrument.ticker.price, 'USD')}
                      </p>
                      <p
                        className={`mt-1 font-mono text-[10px] ${Number(instrument.ticker.change24h) >= 0 ? 'text-[var(--accent)]' : 'text-rose-300'}`}
                      >
                        {Number(instrument.ticker.change24h) >= 0 ? '+' : ''}
                        {Number(instrument.ticker.change24h).toFixed(2)}%{' '}
                        <span className="text-[var(--muted)]">
                          24h · {instrument.ticker.status.toLowerCase()}
                        </span>
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="px-5 py-8 text-sm text-[var(--muted)]">
                Quotes are temporarily unavailable. Your account is unaffected.
              </p>
            )}
            <p className="border-t border-[var(--border)] px-5 py-3 text-[11px] text-[var(--muted)]">
              Follow BTC and ETH in the terminal. Quotes here update on page
              load.
            </p>
          </article>
        </div>
        <section
          className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4"
          aria-label="Portfolio snapshot"
        >
          {[
            [
              'Unrealized P/L',
              portfolio
                ? formatSignedCurrency(portfolio.unrealizedPnl, 'USD')
                : '—',
            ],
            [
              'Used margin',
              portfolio ? formatCurrency(portfolio.usedMargin, 'USD') : '—',
            ],
            [
              'Open positions',
              portfolio ? String(portfolio.positions.length) : '—',
            ],
            [
              'Risk status',
              portfolio
                ? portfolio.riskState.replaceAll('_', ' ')
                : 'Unavailable',
            ],
          ].map(([label, value]) => (
            <article className="panel metric-card" key={label}>
              <h2>{label}</h2>
              <p
                className={
                  label === 'Unrealized P/L' && portfolio
                    ? Number(portfolio.unrealizedPnl) < 0
                      ? 'text-rose-300'
                      : 'text-[var(--accent)]'
                    : ''
                }
              >
                {value}
              </p>
            </article>
          ))}
        </section>
        <p className="mt-3 text-[10px] text-[var(--muted)]">
          Portfolio snapshot at page load. Open the terminal for real-time P/L
          and margin updates.
        </p>
        <div className="mt-6 grid items-start gap-4 xl:grid-cols-[1.35fr_1fr]">
          <section className="panel" data-testid="dashboard-ledger">
            <div className="panel-heading">
              <div>
                <h2>Account activity</h2>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Your latest immutable balance entries.
                </p>
              </div>
              <span className="demo-label">USD</span>
            </div>
            {ledger.items.length ? (
              ledger.items.map((entry) => (
                <div className="ledger-row" key={entry.id}>
                  <span className="entry-icon">
                    <Icon
                      name={entry.type === 'DEMO_CREDIT' ? 'plus' : 'activity'}
                      size={16}
                    />
                  </span>
                  <div>
                    <p className="text-sm">{ledgerLabel(entry.type)}</p>
                    <p className="mt-1 text-[10px] text-[var(--muted)]">
                      {formatDate(entry.createdAt)} · Balance{' '}
                      {formatCurrency(entry.balanceAfter, account.baseCurrency)}
                    </p>
                  </div>
                  <p
                    className={`font-mono text-xs ${Number(entry.amount) < 0 ? 'text-rose-300' : 'text-[var(--accent)]'}`}
                  >
                    {formatSignedCurrency(entry.amount, account.baseCurrency)}
                  </p>
                </div>
              ))
            ) : (
              <p className="p-6 text-sm text-[var(--muted)]">
                No balance activity yet.
              </p>
            )}
          </section>
          <section className="panel p-6">
            <p className="eyebrow">BUILD YOUR RHYTHM</p>
            <h2 className="mt-3 text-xl font-medium tracking-tight">
              A practice worth repeating.
            </h2>
            <p className="mt-2 text-xs leading-6 text-[var(--muted)]">
              A simple loop: define an idea, test it, learn from the result.
            </p>
            <div className="mt-3">
              {[
                [
                  '01',
                  'Choose your market',
                  'Explore BTC and ETH in the terminal.',
                  '/terminal',
                ],
                [
                  '02',
                  'Keep an eye on your setup',
                  'Create a price alert from the terminal.',
                  '/terminal#price-alerts',
                ],
                [
                  '03',
                  'Review the decisions',
                  'Find your patterns in trading reports.',
                  '/reports',
                ],
              ].map(([number, title, description, href]) => (
                <Link className="journey-step" href={href!} key={number}>
                  <span className="journey-number">{number}</span>
                  <div className="flex-1">
                    <p className="journey-title">{title}</p>
                    <p className="journey-description">{description}</p>
                  </div>
                  <Icon name="diagonal" size={16} />
                </Link>
              ))}
            </div>
          </section>
        </div>
      </WorkspaceShell>
    );
  } catch (error) {
    if (error instanceof ExcessApiError && error.status === 401)
      redirect('/sign-in');
    if (error instanceof ExcessApiError && error.status === 403)
      return (
        <PageState
          warning
          title="This account is unavailable."
          message="Your trading records have been retained. Contact support if you believe this is an error."
        />
      );
    throw error;
  }
}
