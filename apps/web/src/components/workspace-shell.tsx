import { UserButton } from '@clerk/nextjs';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Brand } from './brand';
import { Icon, type IconName } from './icon';

const destinations: {
  id: string;
  label: string;
  icon: IconName;
  href: string;
}[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'overview', href: '/dashboard' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal', href: '/terminal' },
  { id: 'reports', label: 'Reports', icon: 'reports', href: '/reports' },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: 'bell',
    href: '/notifications',
  },
  { id: 'admin', label: 'Admin', icon: 'shield', href: '/admin' },
];

export function WorkspaceShell({
  active,
  children,
  admin = false,
  status,
}: {
  active: string;
  children: ReactNode;
  admin?: boolean;
  status?: ReactNode;
}) {
  return (
    <div className="workspace">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="workspace-sidebar">
        <div className="sidebar-brand">
          <Brand />
          <span className="sidebar-caption">THE PRACTICE ADVANTAGE</span>
        </div>
        <p className="nav-caption">Workspace</p>
        <nav aria-label="Workspace navigation" className="workspace-nav">
          {destinations
            .filter((item) => item.id !== 'admin' || admin)
            .map((item) => (
              <Link
                aria-current={active === item.id ? 'page' : undefined}
                className={`workspace-link ${active === item.id ? 'is-active' : ''}`}
                key={item.id}
                href={item.href}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
                {active === item.id ? <span className="nav-indicator" /> : null}
              </Link>
            ))}
        </nav>
        <div className="sidebar-foot">
          <span className="demo-label">
            <Icon name="shield" size={14} /> PAPER TRADING
          </span>
          <p>
            Real markets.
            <br />
            Room to learn.
          </p>
          <small>Virtual funds only. Your money stays out of the market.</small>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="workspace-topbar">
          <div className="mobile-brand">
            <Brand />
          </div>
          <p className="workspace-breadcrumb">
            <span>Workspace</span>
            <span>/</span>
            {destinations.find((item) => item.id === active)?.label}
          </p>
          <div className="workspace-account">
            {status}
            <span className="demo-label">DEMO ACCOUNT</span>
            <UserButton />
          </div>
        </header>
        <main
          className={`workspace-content ${active === 'terminal' ? 'workspace-terminal' : ''}`}
          id="main-content"
          tabIndex={-1}
        >
          {children}
        </main>
        <footer className="workspace-footer">
          <span>Excess · Built for the learning curve.</span>
          <span>Simulated execution. No real funds.</span>
        </footer>
      </div>
    </div>
  );
}
