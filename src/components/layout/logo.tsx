export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="bloom-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5b8c96" />
          <stop offset="1" stopColor="#263d42" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#bloom-g)" />
      <rect x="0.5" y="0.5" width="63" height="63" rx="15.5" fill="none" stroke="white" strokeOpacity="0.15" />
      <circle cx="32" cy="32" r="16" fill="none" stroke="white" strokeWidth="4" opacity="0.9" />
      <circle cx="32" cy="32" r="8" fill="white" />
    </svg>
  );
}
