import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  adjust,
  colorTier,
  expire,
  formatMMSS,
  globalToggleState,
  hasExpired,
  pause,
  remainingSeconds,
  reset,
  setPresence,
  start,
  toggle,
  toggleAction,
  type TimerState,
} from '../timer';

const T0 = Date.parse('2026-08-17T10:00:00+07:00');

function ready(durationSeconds = 900): TimerState {
  return {
    timerStatus: 'ready',
    durationSeconds,
    startedAt: null,
    endsAt: null,
    pausedRemainingSeconds: null,
    timeupAt: null,
  };
}

describe('remaining time is derived from ends_at, never decremented', () => {
  it('reports the full duration before the timer starts', () => {
    assert.equal(remainingSeconds(ready(900), T0), 900);
    assert.equal(remainingSeconds(ready(600), T0), 600);
  });

  it('counts down from ends_at while running', () => {
    const running = start(ready(900), T0);
    assert.equal(remainingSeconds(running, T0), 900);
    assert.equal(remainingSeconds(running, T0 + 60_000), 840);
    assert.equal(remainingSeconds(running, T0 + 899_000), 1);
  });

  it('returns the identical value regardless of when it is asked (refresh safe)', () => {
    const running = start(ready(900), T0);
    const at = T0 + 123_456;
    assert.equal(remainingSeconds(running, at), remainingSeconds(running, at));
    assert.equal(remainingSeconds(running, at), 777);
  });

  it('is correct after a long browser sleep rather than continuing from where it stopped', () => {
    const running = start(ready(900), T0);
    // Phone slept for 20 minutes on a 15 minute timer.
    assert.equal(remainingSeconds(running, T0 + 20 * 60_000), 0);
  });

  it('never goes negative', () => {
    const running = start(ready(600), T0);
    assert.equal(remainingSeconds(running, T0 + 10 * 60 * 60_000), 0);
  });

  it('keeps the frozen value while paused, no matter how much time passes', () => {
    const paused = pause(start(ready(900), T0), T0 + 300_000);
    assert.equal(remainingSeconds(paused, T0 + 300_000), 600);
    assert.equal(remainingSeconds(paused, T0 + 3_600_000), 600);
  });
});

describe('the single Play/Pause/Resume toggle', () => {
  it('starts, pauses and resumes through one action', () => {
    const s0 = ready(900);
    assert.equal(toggleAction(s0), 'start');

    const s1 = toggle(s0, T0);
    assert.equal(s1.timerStatus, 'running');
    assert.equal(toggleAction(s1), 'pause');

    const s2 = toggle(s1, T0 + 120_000);
    assert.equal(s2.timerStatus, 'paused');
    assert.equal(s2.pausedRemainingSeconds, 780);
    assert.equal(toggleAction(s2), 'resume');

    const s3 = toggle(s2, T0 + 600_000);
    assert.equal(s3.timerStatus, 'running');
    // Resuming continues from the frozen 780s, not from the original ends_at.
    assert.equal(remainingSeconds(s3, T0 + 600_000), 780);
  });

  it('keeps started_at across a pause so the meeting start time survives', () => {
    const running = start(ready(900), T0);
    const resumed = start(pause(running, T0 + 60_000), T0 + 300_000);
    assert.equal(resumed.startedAt, running.startedAt);
  });

  it('blocks the toggle when finished, on break, or closed', () => {
    assert.equal(toggleAction(expire(start(ready(900), T0), T0 + 900_000)), 'blocked');
    assert.equal(toggleAction(setPresence(ready(900), 'break', T0)), 'blocked');
    assert.equal(toggleAction(setPresence(ready(900), 'closed', T0)), 'blocked');
  });

  it('refuses to start a timer with nothing left', () => {
    const empty = { ...ready(900), pausedRemainingSeconds: 0 };
    assert.equal(start(empty, T0).timerStatus, 'ready');
  });
});

describe('reset', () => {
  it('returns to the table default duration and clears running state', () => {
    const running = start(ready(900), T0);
    const back = reset(running, 900);
    assert.equal(back.timerStatus, 'ready');
    assert.equal(back.endsAt, null);
    assert.equal(back.startedAt, null);
    assert.equal(back.pausedRemainingSeconds, null);
    assert.equal(remainingSeconds(back, T0 + 500_000), 900);
  });

  it('uses the ten minute default for SHOPEE tables', () => {
    const shopee = reset(start(ready(600), T0), 600);
    assert.equal(remainingSeconds(shopee, T0), 600);
  });
});

describe('expiry', () => {
  it('flags a running timer as expired exactly at zero', () => {
    const running = start(ready(900), T0);
    assert.equal(hasExpired(running, T0 + 899_000), false);
    assert.equal(hasExpired(running, T0 + 900_000), true);
  });

  it('records when it hit zero so clients can pulse for ten seconds', () => {
    const expired = expire(start(ready(900), T0), T0 + 900_000);
    assert.equal(expired.timerStatus, 'timeup');
    assert.equal(remainingSeconds(expired, T0 + 1_000_000), 0);
    assert.equal(expired.timeupAt, new Date(T0 + 900_000).toISOString());
  });
});

describe('one minute adjustments', () => {
  it('extends a running timer without restarting it', () => {
    const running = start(ready(900), T0);
    const extended = adjust(running, 60, T0 + 300_000);
    assert.equal(remainingSeconds(extended, T0 + 300_000), 660);
    assert.equal(extended.timerStatus, 'running');
  });

  it('shortens a running timer', () => {
    const running = start(ready(900), T0);
    assert.equal(remainingSeconds(adjust(running, -60, T0 + 300_000), T0 + 300_000), 540);
  });

  it('adjusts a timer that has not started yet', () => {
    assert.equal(remainingSeconds(adjust(ready(900), 60, T0), T0), 960);
  });

  it('turns a finished timer into a paused one that still needs Resume', () => {
    const expired = expire(start(ready(900), T0), T0 + 900_000);
    const revived = adjust(expired, 60, T0 + 905_000);
    assert.equal(revived.timerStatus, 'paused');
    assert.equal(remainingSeconds(revived, T0 + 905_000), 60);
    assert.equal(toggleAction(revived), 'resume');
  });

  it('clamps at zero instead of going negative', () => {
    const paused = pause(start(ready(900), T0), T0 + 890_000);
    assert.equal(remainingSeconds(adjust(paused, -60, T0 + 890_000), T0 + 890_000), 0);
  });
});

describe('countdown colour bands', () => {
  it('is black above five minutes', () => {
    assert.equal(colorTier(900), 'normal');
    assert.equal(colorTier(301), 'normal');
  });

  it('is orange from 05:00 down to 02:01', () => {
    assert.equal(colorTier(300), 'warning');
    assert.equal(colorTier(121), 'warning');
  });

  it('is red from 02:00 down to 00:01', () => {
    assert.equal(colorTier(120), 'critical');
    assert.equal(colorTier(1), 'critical');
  });

  it('is time-up at zero', () => {
    assert.equal(colorTier(0), 'timeup');
  });
});

describe('MM:SS formatting', () => {
  it('formats the two table durations and edges', () => {
    assert.equal(formatMMSS(900), '15:00');
    assert.equal(formatMMSS(600), '10:00');
    assert.equal(formatMMSS(59), '0:59');
    assert.equal(formatMMSS(0), '0:00');
    assert.equal(formatMMSS(-5), '0:00');
  });
});

describe('global toggle label', () => {
  it('says Pause All when anything is running', () => {
    const states = [start(ready(900), T0), ready(900)];
    assert.equal(globalToggleState(states).label, 'Pause All');
  });

  it('says Play All when nothing is running', () => {
    assert.equal(globalToggleState([ready(900), ready(600)]).label, 'Play All');
  });

  it('reports mixed when running and startable timers coexist', () => {
    assert.equal(globalToggleState([start(ready(900), T0), ready(900)]).mixed, true);
    assert.equal(globalToggleState([start(ready(900), T0), start(ready(600), T0)]).mixed, false);
    assert.equal(globalToggleState([ready(900), ready(600)]).mixed, false);
  });
});

describe('break and closed', () => {
  it('freezes the remaining time and blocks the toggle', () => {
    const running = start(ready(900), T0);
    const onBreak = setPresence(running, 'break', T0 + 120_000);
    assert.equal(onBreak.timerStatus, 'break');
    assert.equal(remainingSeconds(onBreak, T0 + 900_000), 780);
    assert.equal(toggleAction(onBreak), 'blocked');
    assert.equal(toggleAction(setPresence(onBreak, 'ready', T0)), 'resume');
  });
});

describe('restart safety', () => {
  it('rebuilds identical remaining time from persisted columns alone', () => {
    const running = start(ready(900), T0);
    // Exactly what a service restart reads back out of PostgreSQL.
    const rehydrated: TimerState = {
      timerStatus: 'running',
      durationSeconds: running.durationSeconds,
      startedAt: running.startedAt,
      endsAt: running.endsAt,
      pausedRemainingSeconds: null,
      timeupAt: null,
    };
    assert.equal(remainingSeconds(rehydrated, T0 + 400_000), remainingSeconds(running, T0 + 400_000));
    assert.equal(remainingSeconds(rehydrated, T0 + 400_000), 500);
  });
});
