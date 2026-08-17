/**
 * The bare clock board: /Bare_Clock and /Bare_Clock_Control.
 *
 * A deliberately separate system from the matching event. It shares the pure
 * maths in `timer.ts` and nothing else - no appointments, no table_days, no
 * event date. That is why it lives in its own module rather than in
 * `service.ts`: every query here touches exactly one table, `bare_clocks`, so
 * reading this file is enough to be sure the clock board cannot rename a
 * matching table, move an appointment or disturb the room display on event day.
 *
 * Same invariants as the rest of the system:
 *  - the server owns the clock; remaining time is derived from `ends_at`
 *  - one Play/Pause/Resume button, and no Stop
 *  - every mutation is a POST behind `requireOperator`
 */

import type { PoolClient } from 'pg';
import { loadConfig } from './config';
import { query, withTransaction } from './db';
import * as timer from './timer';
import type { TimerState } from './timer';
import { OperationError } from './service';
import type { BareClockRow, BareClockSnapshot, BareClockStateSnapshot } from './types';

/**
 * Read lazily to avoid an import cycle: app.ts -> routes -> bare.ts. Computed
 * once at boot and never changes.
 */
function getAssetVersion(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (require('./app') as typeof import('./app')).ASSET_VERSION;
}

/** Longest label the board can render legibly on a room screen. */
const MAX_LABEL_LENGTH = 40;
/** Guards against an accidental hold-down on "Add clock" filling the screen. */
const MAX_CLOCKS = 24;

let revision = 0;

const SELECT_COLUMNS = `id, label, duration_seconds, timer_status, started_at, ends_at,
                        paused_remaining_seconds, timeup_at, display_order`;

function toTimerState(row: BareClockRow): TimerState {
  return {
    timerStatus: row.timer_status,
    durationSeconds: row.duration_seconds,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    endsAt: row.ends_at ? row.ends_at.toISOString() : null,
    pausedRemainingSeconds: row.paused_remaining_seconds,
    timeupAt: row.timeup_at ? row.timeup_at.toISOString() : null,
  };
}

function toSnapshot(row: BareClockRow, nowMs: number): BareClockSnapshot {
  const state = toTimerState(row);
  const action = timer.toggleAction(state);
  return {
    id: row.id,
    label: row.label,
    durationSeconds: row.duration_seconds,
    durationMinutes: Math.round(row.duration_seconds / 60),
    displayOrder: row.display_order,
    timer: {
      ...state,
      remainingSeconds: timer.remainingSeconds(state, nowMs),
      statusLabel: timer.STATUS_LABELS[state.timerStatus],
      toggleLabel: action === 'pause' ? 'Pause' : action === 'resume' ? 'Resume' : 'Play',
      toggleEnabled: action !== 'blocked',
    },
  };
}

// --- reads ----------------------------------------------------------------

export async function listClocks(): Promise<BareClockRow[]> {
  return query<BareClockRow>(
    `SELECT ${SELECT_COLUMNS} FROM bare_clocks ORDER BY display_order, id`,
  );
}

/** The payload sent to every bare clock screen. */
export async function buildBareSnapshot(nowMs = Date.now()): Promise<BareClockStateSnapshot> {
  const rows = await listClocks();
  const clocks = rows.map((row) => toSnapshot(row, nowMs));
  return {
    serverTime: nowMs,
    assetVersion: getAssetVersion(),
    timezone: loadConfig().timezone,
    clocks,
    global: timer.globalToggleState(clocks.map((c) => c.timer)),
    revision,
  };
}

// --- writes ---------------------------------------------------------------

async function lockClock(client: PoolClient, id: number): Promise<BareClockRow> {
  const row = (
    await client.query<BareClockRow>(
      `SELECT ${SELECT_COLUMNS} FROM bare_clocks WHERE id = $1 FOR UPDATE`,
      [id],
    )
  ).rows[0];
  if (!row) throw new OperationError('That clock no longer exists.', 'not_found');
  return row;
}

async function persist(client: PoolClient, id: number, state: TimerState): Promise<void> {
  await client.query(
    `UPDATE bare_clocks
        SET timer_status = $2,
            duration_seconds = $3,
            started_at = $4,
            ends_at = $5,
            paused_remaining_seconds = $6,
            timeup_at = $7,
            updated_at = now()
      WHERE id = $1`,
    [
      id,
      state.timerStatus,
      state.durationSeconds,
      state.startedAt,
      state.endsAt,
      state.pausedRemainingSeconds,
      state.timeupAt,
    ],
  );
}

async function log(
  client: PoolClient,
  action: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  // table_code stays null: a bare clock is not a matching table, and writing an
  // id into that column would make the event's operation log read as if a
  // matching table had been touched.
  await client.query(
    `INSERT INTO operation_log (action, table_code, appointment_id, detail)
     VALUES ($1, NULL, NULL, $2::jsonb)`,
    [action, JSON.stringify(detail)],
  );
}

/** The one Play/Pause/Resume toggle. */
export async function toggleClock(id: number): Promise<void> {
  await withTransaction(async (client) => {
    const row = await lockClock(client, id);
    const state = toTimerState(row);
    const action = timer.toggleAction(state);
    if (action === 'blocked') {
      throw new OperationError(`${row.label} has finished. Press Reset to run it again.`);
    }
    await persist(client, id, timer.toggle(state, Date.now()));
    await log(client, `bare.${action}`, { clockId: id, label: row.label, from: state.timerStatus });
  });
  revision += 1;
}

/** Back to this clock's own length. */
export async function resetClock(id: number): Promise<void> {
  await withTransaction(async (client) => {
    const row = await lockClock(client, id);
    const state = toTimerState(row);
    await persist(client, id, timer.reset(state, row.duration_seconds));
    await log(client, 'bare.reset', { clockId: id, label: row.label, from: state.timerStatus });
  });
  revision += 1;
}

export async function adjustClock(id: number, deltaSeconds: number): Promise<void> {
  await withTransaction(async (client) => {
    const row = await lockClock(client, id);
    await persist(client, id, timer.adjust(toTimerState(row), deltaSeconds, Date.now()));
    await log(client, 'bare.adjust', { clockId: id, label: row.label, deltaSeconds });
  });
  revision += 1;
}

/**
 * Types a new length onto a clock.
 *
 * `input` is whatever the operator typed - minutes, MM:SS or a seconds value
 * with a unit. Parsing lives in `timer.parseDurationSeconds` so it is unit
 * tested; the rule for what happens to a *running* clock lives in
 * `timer.setDuration`.
 */
export async function setClockDuration(id: number, input: unknown): Promise<{ durationSeconds: number }> {
  const seconds = timer.parseDurationSeconds(input);
  if (seconds === null) {
    throw new OperationError(
      'Enter a length in minutes (for example 15, 7.5 or 12:30), up to 6 hours.',
      'bad_request',
    );
  }

  await withTransaction(async (client) => {
    const row = await lockClock(client, id);
    const state = toTimerState(row);
    await persist(client, id, timer.setDuration(state, seconds, Date.now()));
    await log(client, 'bare.duration', {
      clockId: id,
      label: row.label,
      durationSeconds: seconds,
      wasRunning: state.timerStatus === 'running',
    });
  });
  revision += 1;
  return { durationSeconds: seconds };
}

/** Trimmed, length-checked label. Rejects an empty rename rather than blanking a card. */
function cleanLabel(value: unknown): string {
  const label = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!label) throw new OperationError('A clock needs a name.', 'bad_request');
  if (label.length > MAX_LABEL_LENGTH) {
    throw new OperationError(
      `Keep the name to ${MAX_LABEL_LENGTH} characters or fewer so it fits the screen.`,
      'bad_request',
    );
  }
  return label;
}

export async function renameClock(id: number, value: unknown): Promise<{ label: string }> {
  const label = cleanLabel(value);
  await withTransaction(async (client) => {
    const row = await lockClock(client, id);
    await client.query(`UPDATE bare_clocks SET label = $2, updated_at = now() WHERE id = $1`, [
      id,
      label,
    ]);
    await log(client, 'bare.rename', { clockId: id, from: row.label, to: label });
  });
  revision += 1;
  return { label };
}

export async function createClock(
  labelInput: unknown,
  durationInput: unknown,
): Promise<{ id: number; label: string }> {
  const label = cleanLabel(labelInput);
  const seconds = durationInput === undefined || durationInput === null || durationInput === ''
    ? 900
    : timer.parseDurationSeconds(durationInput);
  if (seconds === null) {
    throw new OperationError(
      'Enter a length in minutes (for example 15, 7.5 or 12:30), up to 6 hours.',
      'bad_request',
    );
  }

  const created = await withTransaction(async (client) => {
    const count = Number(
      (await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM bare_clocks`))
        .rows[0].count,
    );
    if (count >= MAX_CLOCKS) {
      throw new OperationError(`The board holds ${MAX_CLOCKS} clocks. Delete one first.`);
    }

    const row = (
      await client.query<{ id: number }>(
        `INSERT INTO bare_clocks (label, duration_seconds, display_order)
         VALUES ($1, $2, COALESCE((SELECT max(display_order) FROM bare_clocks), 0) + 1)
         RETURNING id`,
        [label, seconds],
      )
    ).rows[0];
    await log(client, 'bare.create', { clockId: row.id, label, durationSeconds: seconds });
    return { id: row.id, label };
  });

  revision += 1;
  return created;
}

/**
 * Deletes a clock outright.
 *
 * Unlike an appointment, a bare clock carries no record worth keeping - there is
 * no roster behind it - so it is really deleted rather than parked. The control
 * page confirms first.
 */
export async function deleteClock(id: number): Promise<{ label: string }> {
  const result = await withTransaction(async (client) => {
    const row = await lockClock(client, id);
    await client.query(`DELETE FROM bare_clocks WHERE id = $1`, [id]);
    await log(client, 'bare.delete', { clockId: id, label: row.label });
    return { label: row.label };
  });
  revision += 1;
  return result;
}

/** Play All / Pause All across the whole board. */
export async function globalToggleClocks(): Promise<'play' | 'pause'> {
  const action = await withTransaction(async (client) => {
    const rows = (
      await client.query<BareClockRow>(
        `SELECT ${SELECT_COLUMNS} FROM bare_clocks ORDER BY display_order, id FOR UPDATE`,
      )
    ).rows;

    const now = Date.now();
    const anyRunning = rows.some((r) => r.timer_status === 'running');

    for (const row of rows) {
      const state = toTimerState(row);
      if (anyRunning) {
        if (state.timerStatus !== 'running') continue;
        await persist(client, row.id, timer.pause(state, now));
      } else {
        if (state.timerStatus !== 'ready' && state.timerStatus !== 'paused') continue;
        if (timer.remainingSeconds(state, now) <= 0) continue;
        await persist(client, row.id, timer.start(state, now));
      }
    }

    const next: 'play' | 'pause' = anyRunning ? 'pause' : 'play';
    await log(client, `bare.global_${next}`, { clocks: rows.length });
    return next;
  });
  revision += 1;
  return action;
}

export async function globalResetClocks(): Promise<void> {
  await withTransaction(async (client) => {
    const reset = await client.query(
      `UPDATE bare_clocks
          SET timer_status = 'ready',
              started_at = NULL,
              ends_at = NULL,
              paused_remaining_seconds = NULL,
              timeup_at = NULL,
              updated_at = now()`,
    );
    await log(client, 'bare.global_reset', { clocks: reset.rowCount });
  });
  revision += 1;
}

/**
 * Flips finished clocks to `timeup`. Called by the authoritative server tick -
 * the same one that expires the matching tables - so a bare clock reaches zero
 * whether or not anyone has a page open.
 */
export async function expireFinishedClocks(nowMs = Date.now()): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `UPDATE bare_clocks
        SET timer_status = 'timeup',
            paused_remaining_seconds = 0,
            timeup_at = COALESCE(timeup_at, now()),
            updated_at = now()
      WHERE timer_status = 'running'
        AND ends_at IS NOT NULL
        AND ends_at <= to_timestamp($1 / 1000.0)
      RETURNING id`,
    [nowMs],
  );
  if (rows.length > 0) revision += 1;
  return rows.map((r) => r.id);
}
