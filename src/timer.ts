/**
 * Pure, side-effect-free timer maths.
 *
 * The server is the single authority on time. A timer is never "decremented":
 * while running, the remaining time is derived from `endsAt`; while paused or
 * adjusted-but-not-started, it lives in `pausedRemainingSeconds`. Every
 * transition here is a pure function so it can be unit tested and so the same
 * rules apply to a fresh page load, a reconnect, or a service restart.
 */

export type TimerStatus = 'ready' | 'running' | 'paused' | 'timeup' | 'break' | 'closed';

export interface TimerState {
  timerStatus: TimerStatus;
  durationSeconds: number;
  /** ISO-8601 instant, or null when the timer has not been started. */
  startedAt: string | null;
  /** ISO-8601 instant the timer reaches zero. Authoritative while running. */
  endsAt: string | null;
  /** Frozen remaining seconds while paused, or an adjusted ready value. */
  pausedRemainingSeconds: number | null;
  /** ISO-8601 instant the timer hit zero; drives the 10s pulse on clients. */
  timeupAt: string | null;
}

/** Longest value a manual adjustment may produce (safety clamp). */
export const MAX_REMAINING_SECONDS = 6 * 60 * 60;

/** How long the "time up" pulse animation runs before going steady red. */
export const TIMEUP_PULSE_MS = 10_000;

export function clampRemaining(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.min(MAX_REMAINING_SECONDS, Math.max(0, Math.round(seconds)));
}

/**
 * Remaining seconds for any state at instant `nowMs`.
 *
 * - running: derived from `endsAt` (survives refresh, sleep and reconnect)
 * - paused / break / closed: the frozen value
 * - ready: the frozen value if the operator adjusted it, else the full duration
 * - timeup: always zero
 */
export function remainingSeconds(state: TimerState, nowMs: number): number {
  switch (state.timerStatus) {
    case 'running': {
      if (!state.endsAt) return clampRemaining(state.durationSeconds);
      const deltaMs = Date.parse(state.endsAt) - nowMs;
      return clampRemaining(Math.ceil(deltaMs / 1000));
    }
    case 'paused':
    case 'break':
    case 'closed':
      return clampRemaining(state.pausedRemainingSeconds ?? state.durationSeconds);
    case 'timeup':
      return 0;
    case 'ready':
    default:
      return clampRemaining(state.pausedRemainingSeconds ?? state.durationSeconds);
  }
}

/** True when a running timer has reached zero and must be flipped to `timeup`. */
export function hasExpired(state: TimerState, nowMs: number): boolean {
  return state.timerStatus === 'running' && remainingSeconds(state, nowMs) <= 0;
}

/** The single Play/Pause/Resume button's current meaning. */
export type ToggleAction = 'start' | 'pause' | 'resume' | 'blocked';

export function toggleAction(state: TimerState): ToggleAction {
  switch (state.timerStatus) {
    case 'ready':
      return 'start';
    case 'running':
      return 'pause';
    case 'paused':
      return 'resume';
    // A finished, broken or closed table must be reset (or re-opened) first;
    // there is deliberately no Stop button anywhere in the system.
    case 'timeup':
    case 'break':
    case 'closed':
    default:
      return 'blocked';
  }
}

/** Starts a ready timer, or resumes a paused one. Both go through here. */
export function start(state: TimerState, nowMs: number): TimerState {
  const remaining = remainingSeconds(state, nowMs);
  if (remaining <= 0) return state;
  return {
    ...state,
    timerStatus: 'running',
    startedAt: state.timerStatus === 'paused' && state.startedAt
      ? state.startedAt
      : new Date(nowMs).toISOString(),
    endsAt: new Date(nowMs + remaining * 1000).toISOString(),
    pausedRemainingSeconds: null,
    timeupAt: null,
  };
}

export function pause(state: TimerState, nowMs: number): TimerState {
  if (state.timerStatus !== 'running') return state;
  return {
    ...state,
    timerStatus: 'paused',
    pausedRemainingSeconds: remainingSeconds(state, nowMs),
    endsAt: null,
  };
}

/** The one toggle. Returns the state unchanged when the action is blocked. */
export function toggle(state: TimerState, nowMs: number): TimerState {
  const action = toggleAction(state);
  if (action === 'pause') return pause(state, nowMs);
  if (action === 'start' || action === 'resume') return start(state, nowMs);
  return state;
}

/** Back to the table's default duration. Never touches the queue. */
export function reset(state: TimerState, durationSeconds: number): TimerState {
  return {
    ...state,
    timerStatus: 'ready',
    durationSeconds,
    startedAt: null,
    endsAt: null,
    pausedRemainingSeconds: null,
    timeupAt: null,
  };
}

/** Marks a running timer as finished. Called by the authoritative server tick. */
export function expire(state: TimerState, nowMs: number): TimerState {
  return {
    ...state,
    timerStatus: 'timeup',
    endsAt: state.endsAt ?? new Date(nowMs).toISOString(),
    pausedRemainingSeconds: 0,
    timeupAt: state.timeupAt ?? new Date(nowMs).toISOString(),
  };
}

/**
 * Adds or removes time (the +1/-1 minute operations).
 * A running timer keeps running with a moved `endsAt`; a finished timer that
 * gains time becomes paused so the operator still has to press Resume.
 */
export function adjust(state: TimerState, deltaSeconds: number, nowMs: number): TimerState {
  const next = clampRemaining(remainingSeconds(state, nowMs) + deltaSeconds);

  if (state.timerStatus === 'running') {
    if (next <= 0) return expire({ ...state, endsAt: new Date(nowMs).toISOString() }, nowMs);
    return { ...state, endsAt: new Date(nowMs + next * 1000).toISOString(), timeupAt: null };
  }

  if (state.timerStatus === 'timeup') {
    if (next <= 0) return state;
    return { ...state, timerStatus: 'paused', pausedRemainingSeconds: next, endsAt: null, timeupAt: null };
  }

  return { ...state, pausedRemainingSeconds: next, endsAt: null };
}

/** Marks a table as on Break or Closed, freezing whatever time is left. */
export function setPresence(
  state: TimerState,
  status: Extract<TimerStatus, 'break' | 'closed' | 'ready'>,
  nowMs: number,
): TimerState {
  if (status === 'ready') {
    // Re-opening a table restores the state the break interrupted: a meeting
    // that was part-way through comes back Paused (so the button reads Resume
    // and the remaining time is kept), an untouched table comes back Ready.
    const frozen = state.pausedRemainingSeconds;
    const partial = frozen !== null && frozen > 0 && frozen < state.durationSeconds;
    return {
      ...state,
      timerStatus: partial ? 'paused' : 'ready',
      endsAt: null,
      timeupAt: null,
    };
  }
  return {
    ...state,
    timerStatus: status,
    pausedRemainingSeconds: remainingSeconds(state, nowMs),
    endsAt: null,
  };
}

export type ColorTier = 'normal' | 'warning' | 'critical' | 'timeup';

/**
 * Countdown colour bands from the design spec:
 *   above 05:00        -> black   (normal)
 *   05:00 .. 02:01     -> orange  (warning)
 *   02:00 .. 00:01     -> red     (critical)
 *   00:00              -> red + "TIME UP"
 */
export function colorTier(remaining: number): ColorTier {
  if (remaining <= 0) return 'timeup';
  if (remaining <= 120) return 'critical';
  if (remaining <= 300) return 'warning';
  return 'normal';
}

export function formatMMSS(remaining: number): string {
  const total = Math.max(0, Math.floor(remaining));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export const STATUS_LABELS: Record<TimerStatus, string> = {
  ready: 'Ready',
  running: 'Running',
  paused: 'Paused',
  timeup: 'Time Up',
  break: 'Break',
  closed: 'Closed',
};

/**
 * Label for the single global toggle:
 *  - any running timer -> "Pause All"
 *  - none running      -> "Play All"
 *  - both running and paused/ready present -> mixed
 */
export function globalToggleState(states: TimerState[]): {
  action: 'play' | 'pause';
  label: string;
  mixed: boolean;
} {
  const running = states.filter((s) => s.timerStatus === 'running').length;
  const startable = states.filter(
    (s) => s.timerStatus === 'ready' || s.timerStatus === 'paused',
  ).length;
  const mixed = running > 0 && startable > 0;
  return running > 0
    ? { action: 'pause', label: 'Pause All', mixed }
    : { action: 'play', label: 'Play All', mixed };
}
