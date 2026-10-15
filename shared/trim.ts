/** Shortest segment that may be exported. */
export const MIN_SEGMENT_MS = 500;

export type TrimValidation = { ok: true } | { ok: false; error: string };

export function validateTrim(startMs: number, endMs: number, durationMs: number | null): TrimValidation {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { ok: false, error: 'Trim points must be numbers' };
  if (startMs < 0) return { ok: false, error: 'Start cannot be before the beginning of the video' };
  if (endMs <= startMs) return { ok: false, error: 'End must be after start' };
  if (endMs - startMs < MIN_SEGMENT_MS) {
    return { ok: false, error: `Selection must be at least ${MIN_SEGMENT_MS / 1000}s long` };
  }
  if (durationMs !== null) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return { ok: false, error: 'Video duration is unknown' };
    // Allow a little slack for container rounding.
    if (endMs > durationMs + 50) return { ok: false, error: 'End is past the end of the video' };
  }
  return { ok: true };
}

/** Clamp a pair of handles to the video, keeping them at least MIN_SEGMENT_MS apart. */
export function clampTrim(startMs: number, endMs: number, durationMs: number): { startMs: number; endMs: number } {
  const dur = Math.max(0, durationMs);
  const minGap = Math.min(MIN_SEGMENT_MS, dur);
  let s = Math.min(Math.max(0, startMs), Math.max(0, dur - minGap));
  let e = Math.max(Math.min(dur, endMs), s + minGap);
  s = Math.round(s);
  e = Math.round(Math.min(e, dur));
  return { startMs: s, endMs: e };
}

export function isFullRange(startMs: number, endMs: number, durationMs: number): boolean {
  return startMs <= 0 && endMs >= durationMs - 50;
}
