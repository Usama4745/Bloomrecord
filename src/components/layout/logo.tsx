export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="bloom-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f0509a" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#bloom-g)" />
      <circle cx="32" cy="32" r="16" fill="none" stroke="white" strokeWidth="4" opacity="0.9" />
      <circle cx="32" cy="32" r="8" fill="white" />
    </svg>
  );
}
