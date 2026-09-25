// Deliberately illustrative; this marketing preview never represents live prices.
const candles = [
  [180, 161],
  [161, 170],
  [170, 150],
  [150, 159],
  [159, 140],
  [140, 154],
  [154, 144],
  [144, 127],
  [127, 140],
  [140, 158],
  [158, 149],
  [149, 133],
  [133, 113],
  [113, 123],
  [123, 105],
  [105, 88],
  [88, 102],
  [102, 120],
  [120, 106],
  [106, 96],
  [96, 111],
  [111, 90],
  [90, 74],
  [74, 83],
  [83, 66],
  [66, 77],
  [77, 60],
  [60, 47],
  [47, 63],
  [63, 50],
  [50, 36],
  [36, 44],
];

export function TerminalPreview() {
  return (
    <figure
      className="terminal-preview"
      aria-label="Illustrative preview of the Excess trading terminal"
    >
      <figcaption className="preview-title">
        <span className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />{' '}
          EXCESS / TERMINAL
        </span>
        <span className="demo-label">DEMO</span>
      </figcaption>
      <div className="flex items-center justify-between px-5 pt-5">
        <div>
          <p className="text-xs text-[var(--muted)]">
            Bitcoin{' '}
            <span className="ml-2 font-mono text-[10px]">BTC / USD</span>
          </p>
          <p className="mt-2 font-mono text-3xl tracking-tight">
            65,240<span className="text-[var(--muted)]">.80</span>
          </p>
        </div>
        <span className="rounded bg-[var(--accent)]/10 px-2 py-1 font-mono text-[10px] text-[var(--accent)]">
          +2.14%
        </span>
      </div>
      <svg
        className="preview-chart"
        aria-hidden="true"
        viewBox="0 0 480 260"
        fill="none"
      >
        {[50, 100, 150, 200].map((y) => (
          <path key={y} d={`M20 ${y}H460`} stroke="#ffffff09" />
        ))}
        {[70, 150, 230, 310, 390].map((x) => (
          <path key={x} d={`M${x} 25V228`} stroke="#ffffff05" />
        ))}
        {candles.map(([open, close], i) => {
          const x = 26 + i * 13;
          const up = close! < open!;
          const top = Math.min(open!, close!);
          const bottom = Math.max(open!, close!);
          return (
            <g
              key={i}
              stroke={up ? '#b6ed72' : '#e88392'}
              fill={up ? '#b6ed72' : '#e88392'}
            >
              <path d={`M${x} ${top - 9}V${bottom + 10}`} strokeWidth="1" />
              <rect
                x={x - 3.5}
                y={top}
                width="7"
                height={bottom - top}
                rx="1"
                stroke="none"
              />
              <rect
                x={x - 3.5}
                y={246 - ((i % 5) + 1) * 4}
                width="7"
                height={((i % 5) + 1) * 4}
                opacity=".18"
                stroke="none"
              />
            </g>
          );
        })}
        <path
          d="M20 44H460"
          stroke="#b6ed72"
          strokeOpacity=".5"
          strokeDasharray="3 5"
        />
      </svg>
      <div className="mx-5 mb-5 grid grid-cols-3 gap-2 border-t border-[var(--border)] pt-4 text-[10px]">
        <div>
          <p className="text-[var(--muted)]">ORDER TYPE</p>
          <p className="mt-2">Market</p>
        </div>
        <div>
          <p className="text-[var(--muted)]">QUANTITY</p>
          <p className="mt-2 font-mono">0.01 BTC</p>
        </div>
        <div className="rounded-md bg-[var(--accent)]/10 p-2 text-center text-[var(--accent)]">
          Simulated
          <br />
          execution
        </div>
      </div>
      <div className="preview-footer">
        <span>Interface preview · Illustrative prices</span>
        <span>Not a live quote</span>
      </div>
    </figure>
  );
}
