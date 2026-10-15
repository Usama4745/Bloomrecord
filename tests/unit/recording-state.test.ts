import { describe, expect, it } from 'vitest';
import { activeDurationMs, canTransition, InvalidTransitionError, isRecoverable, nextStatus } from '@shared/recording-state';

describe('recording state machine', () => {
  it('follows the happy path', () => {
    let s = nextStatus('recording', 'pause');
    expect(s).toBe('paused');
    s = nextStatus(s, 'resume');
    expect(s).toBe('recording');
    s = nextStatus(s, 'stop');
    expect(s).toBe('stopping');
    s = nextStatus(s, 'process');
    expect(s).toBe('processing');
    expect(nextStatus(s, 'complete')).toBe('completed');
  });

  it('rejects conflicting operations', () => {
    expect(() => nextStatus('recording', 'resume')).toThrow(InvalidTransitionError);
    expect(() => nextStatus('paused', 'pause')).toThrow(/Cannot pause/);
    expect(() => nextStatus('stopping', 'stop')).toThrow();
    expect(() => nextStatus('completed', 'recover')).toThrow();
    expect(canTransition('processing', 'pause')).toBe(false);
  });

  it('allows recovery of failed and interrupted sessions only', () => {
    expect(nextStatus('failed', 'recover')).toBe('processing');
    expect(nextStatus('interrupted', 'recover')).toBe('processing');
    expect(nextStatus('interrupted', 'discard')).toBe('discarded');
    expect(isRecoverable('completed')).toBe(false);
    expect(isRecoverable('interrupted')).toBe(true);
    for (const s of ['recording', 'paused', 'stopping', 'processing'] as const) {
      expect(nextStatus(s, 'interrupt')).toBe('interrupted');
    }
  });

  it('computes active duration excluding pauses', () => {
    expect(activeDurationMs(0, [], 10_000)).toBe(10_000);
    expect(activeDurationMs(0, [{ startedAt: 2000, endedAt: 5000 }], 10_000)).toBe(7000);
    // Open pause counts until now.
    expect(activeDurationMs(0, [{ startedAt: 8000, endedAt: null }], 10_000)).toBe(8000);
    // Explicit end clamps pauses.
    expect(activeDurationMs(0, [{ startedAt: 4000, endedAt: 20_000 }], 99_999, 6000)).toBe(4000);
    expect(
      activeDurationMs(
        1000,
        [
          { startedAt: 2000, endedAt: 3000 },
          { startedAt: 5000, endedAt: 6000 },
        ],
        10_000,
      ),
    ).toBe(7000);
  });
});
