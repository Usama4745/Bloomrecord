/**
 * Parses FFmpeg `-progress pipe:1` output (key=value lines). Returns the
 * processed media time in ms when a line carries it, `'end'` at completion,
 * or null for other keys.
 */
export function parseProgressLine(line: string): number | 'end' | null {
  const eq = line.indexOf('=');
  if (eq < 0) return null;
  const key = line.slice(0, eq).trim();
  const value = line.slice(eq + 1).trim();
  if (key === 'progress' && value === 'end') return 'end';
  // out_time_us and out_time_ms are both microseconds in FFmpeg (a long-standing quirk).
  if (key === 'out_time_us' || key === 'out_time_ms') {
    const us = Number(value);
    return Number.isFinite(us) && us >= 0 ? us / 1000 : null;
  }
  if (key === 'out_time') {
    const m = /^(-?\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value);
    if (!m) return null;
    const ms = (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
    return ms >= 0 ? ms : null;
  }
  return null;
}

/** Builds a progress callback that maps media time to a 0..1 fraction (or null if the total is unknown). */
export function progressReporter(totalMs: number | null, report: (fraction: number | null) => void): (line: string) => void {
  let last = -1;
  return (line) => {
    const v = parseProgressLine(line);
    if (v === null) return;
    if (v === 'end') {
      report(1);
      return;
    }
    if (!totalMs || totalMs <= 0) {
      report(null);
      return;
    }
    const f = Math.min(0.999, Math.max(0, v / totalMs));
    if (f - last >= 0.005) {
      last = f;
      report(f);
    }
  };
}
