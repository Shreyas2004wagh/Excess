const paths = {
  overview: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  terminal: 'M5 3v18M2 8h6v7H2zM12 2v20M9 5h6v6H9zM19 3v18M16 12h6v5h-6z',
  reports: 'M4 3v18h17M8 16v-5M13 16V7M18 16V4',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  shield: 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4ZM8 12l3 3 5-6',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  diagonal: 'M6 18 18 6M6 6h12v12',
  wallet: 'M20 8V4H6a3 3 0 0 0 0 6h15v10H6a3 3 0 0 1-3-3V7M21 13h-6v4h6',
  check: 'M5 12l4 4L19 6',
  download: 'M12 3v12M7 10l5 5 5-5M4 16v5h16v-5',
  refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M18 18A8 8 0 0 1 5 16',
  activity: 'M2 12h5l3-8 4 16 3-8h5',
  clock: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  plus: 'M12 5v14M5 12h14',
} as const;

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 18,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={paths[name]} />
    </svg>
  );
}
