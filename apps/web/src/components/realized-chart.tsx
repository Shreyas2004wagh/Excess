'use client';

import type { TradingReportDay } from '@excess/shared-types';
import { useId } from 'react';
import { formatCurrency } from '../lib/format';
import { pnlChartGeometry } from '../lib/pnl-chart';

export function RealizedChart({ days }: { days: TradingReportDay[] }) {
  const id = useId();
  const geometry = pnlChartGeometry(
    days.map((day) => Number(day.cumulativeRealizedPnl)),
  );
  const last = days.at(-1)?.cumulativeRealizedPnl ?? '0';
  const color = Number(last) < 0 ? 'var(--negative)' : 'var(--accent)';
  const empty = days.every((day) => day.executions === 0);
  return (
    <figure className="panel mt-5 overflow-hidden" data-testid="realized-chart">
      <figcaption className="panel-heading">
        <div>
          <h2>Realized performance</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Cumulative credited P/L · starts at zero for this period
          </p>
        </div>
        <span className="font-mono text-lg" style={{ color }}>
          {formatCurrency(last, 'USD')}
        </span>
      </figcaption>
      <div className="relative px-4 pb-4 pt-3 sm:px-6">
        <div className="flex justify-between text-[10px] text-[var(--muted)]">
          <span>Range low {formatCurrency(String(geometry.low), 'USD')}</span>
          <span>Range high {formatCurrency(String(geometry.high), 'USD')}</span>
        </div>
        <svg
          viewBox="0 0 700 200"
          role="img"
          aria-labelledby={`${id}-title ${id}-description`}
          className="my-2 block h-44 w-full sm:h-56"
          preserveAspectRatio="none"
        >
          <title id={`${id}-title`}>Cumulative realized profit and loss</title>
          <desc id={`${id}-description`}>
            {empty
              ? 'No executions in this period.'
              : `From zero to ${formatCurrency(last, 'USD')} over the selected period. This is realized P/L, not account equity. Daily values are in the table below.`}
          </desc>
          <defs>
            <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity=".16" />
              <stop offset="100%" stopColor={color} stopOpacity=".01" />
            </linearGradient>
          </defs>
          {[40, 80, 120, 160].map((y) => (
            <path
              key={y}
              d={`M16 ${y}H684`}
              stroke="var(--border)"
              strokeOpacity=".5"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <path
            d={`M16 ${geometry.zeroY}H684`}
            stroke="var(--muted)"
            strokeDasharray="3 5"
            strokeOpacity=".6"
            vectorEffect="non-scaling-stroke"
          />
          <path d={geometry.area} fill={`url(#${id}-fill)`} />
          <path
            d={geometry.line}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {empty ? (
          <p className="absolute inset-x-0 top-20 text-center text-xs text-[var(--muted)]">
            <span className="rounded-lg bg-[var(--surface)] px-3 py-2">
              Your realized results will appear here.
            </span>
          </p>
        ) : null}
        <div className="flex justify-between font-mono text-[10px] text-[var(--muted)]">
          <span>{days[0]?.date}</span>
          <span>UTC</span>
          <span>{days.at(-1)?.date}</span>
        </div>
      </div>
    </figure>
  );
}
