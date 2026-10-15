import type { PauseInterval, SessionStatus } from './recording-types';

export type SessionEvent =
  | 'pause'
  | 'resume'
  | 'stop'
  | 'process'
  | 'complete'
  | 'fail'
  | 'interrupt'
  | 'recover'
  | 'discard';

const TRANSITIONS: Record<SessionStatus, Partial<Record<SessionEvent, SessionStatus>>> = {
  recording: { pause: 'paused', stop: 'stopping', fail: 'failed', interrupt: 'interrupted' },
  paused: { resume: 'recording', stop: 'stopping', fail: 'failed', interrupt: 'interrupted' },
  stopping: { process: 'processing', fail: 'failed', interrupt: 'interrupted' },
  processing: { complete: 'completed', fail: 'failed', interrupt: 'interrupted' },
  failed: { recover: 'processing', discard: 'discarded' },
  interrupted: { recover: 'processing', discard: 'discarded' },
  completed: {},
  discarded: {},
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: SessionStatus,
    readonly event: SessionEvent,
  ) {
    super(`Cannot ${event} a recording session that is ${from}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: SessionStatus, event: SessionEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

export function nextStatus(from: SessionStatus, event: SessionEvent): SessionStatus {
  const to = TRANSITIONS[from][event];
  if (!to) throw new InvalidTransitionError(from, event);
  return to;
}

/** A session in one of these states is actively capturing and must not be processed. */
export function isCapturing(status: SessionStatus): boolean {
  return status === 'recording' || status === 'paused';
}

/** A session in one of these states was cut short and can be recovered or discarded. */
export function isRecoverable(status: SessionStatus): boolean {
  return status === 'interrupted' || status === 'failed';
}

/** Statuses that indicate the app died mid-session if found at startup. */
export const UNFINISHED_STATUSES: SessionStatus[] = ['recording', 'paused', 'stopping', 'processing'];

/**
 * Wall-clock time spent recording, excluding pauses.
 * An open pause (endedAt === null) counts as ending at `now`.
 */
export function activeDurationMs(startedAt: number, pauses: PauseInterval[], now: number, endedAt?: number | null): number {
  const end = endedAt ?? now;
  let paused = 0;
  for (const p of pauses) {
    const pEnd = p.endedAt ?? end;
    paused += Math.max(0, Math.min(pEnd, end) - Math.max(p.startedAt, startedAt));
  }
  return Math.max(0, end - startedAt - paused);
}
