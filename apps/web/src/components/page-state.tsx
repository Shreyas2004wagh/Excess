import Link from 'next/link';
import { Brand } from './brand';
import { Icon } from './icon';

export function PageState({
  title,
  message,
  action,
  actionLabel = 'Try again',
  warning = false,
}: {
  title: string;
  message: string;
  action?: () => void;
  actionLabel?: string;
  warning?: boolean;
}) {
  return (
    <main className="state-page">
      <Brand />
      <div className="state-panel">
        <span className={`state-icon ${warning ? 'state-warning' : ''}`}>
          <Icon name={warning ? 'shield' : 'activity'} size={28} />
        </span>
        <p className="eyebrow">
          {warning ? 'Account access' : 'Connection interrupted'}
        </p>
        <h1>{title}</h1>
        <p className="state-description">{message}</p>
        <div className="flex flex-wrap justify-center gap-3">
          {action ? (
            <button
              className="button button-primary"
              onClick={action}
              type="button"
            >
              <Icon name="refresh" size={16} />
              {actionLabel}
            </button>
          ) : null}
          <Link className="button button-secondary" href="/dashboard">
            Back to dashboard
          </Link>
        </div>
      </div>
      <p className="state-footnote">Your trading records remain safe.</p>
    </main>
  );
}

export function WorkspaceLoading({ label }: { label: string }) {
  return (
    <main className="loading-page" aria-busy="true">
      <Brand />
      <p className="eyebrow mt-12" role="status">
        {label}
      </p>
      <div className="skeleton mt-5 h-10 w-60" />
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {[1, 2, 3].map((item) => (
          <div key={item} className="skeleton h-36" />
        ))}
      </div>
      <div className="skeleton mt-5 h-80" />
    </main>
  );
}
