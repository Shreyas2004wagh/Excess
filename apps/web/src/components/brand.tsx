import Link from 'next/link';

export function Brand() {
  return (
    <Link className="brand" href="/" aria-label="Excess home">
      <svg
        aria-hidden="true"
        width="29"
        height="29"
        viewBox="0 0 32 32"
        fill="none"
      >
        <rect width="32" height="32" rx="8" fill="currentColor" />
        <path
          d="m9 7 15 0-3 4H6l3-4Zm0 7h11l-3 4H6l3-4Zm0 7h7l-3 4H6l3-4Z"
          fill="#10130d"
        />
      </svg>
      <span>
        excess<span className="brand-period">.</span>
      </span>
    </Link>
  );
}
