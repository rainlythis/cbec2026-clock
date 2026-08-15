import type { PoolClient } from 'pg';
import { EVENT_DATES, EVENT_SESSIONS } from './config';
import { query, queryOne, withTransaction } from './db';
import { logger } from './logger';
import * as timer from './timer';
import type { TimerState, TimerStatus } from './timer';
import type {
  AppointmentRow,
  AppointmentStatus,
  EventSettingsRow,
  PublicAppointment,
  StateSnapshot,
  TableDayRow,
  TableRow,
  TableSnapshot,
  TimeSlotRow,
  TimerRow,
} from './types';
import type { ScheduleRow } from './csv';
import { FROZEN_STATUSES, canMoveBetween, guardCellEdit, planCompaction } from './grid';
import {
  queueNumberFor,
  slotKey,
  tableDayKey,
  type RosterRow,
  type RosterValidationContext,
} from './roster';

/** Thrown for operator mistakes; surfaced as a 409 with a readable message. */
export class OperationError extends Error {
  constructor(message: string, readonly code = 'conflict') {
    super(message);
    this.name = 'OperationError';
  }
}

let revision = 0;
export function bumpRevision(): number {
  revision += 1;
  return revision;
}

// --- reads ----------------------------------------------------------------

export async function getSettings(): Promise<EventSettingsRow> {
  const row = await queryOne<EventSettingsRow>(
    `SELECT event_name, active_event_date, timezone, sound_enabled
       FROM event_settings WHERE id = 1`,
  );
  if (!row) throw new Error('event_settings row is missing - run the migrations.');
  return row;
}

export async function getTables(): Promise<TableRow[]> {
  return query<TableRow>(
    `SELECT table_code, platform, duration_seconds, zone, display_order
       FROM matching_tables ORDER BY display_order`,
  );
}

/**
 * The ten tables as they trade on one specific day.
 *
 * Every day-facing read goes through here rather than through matching_tables,
 * because positions 7 and 8 change vendor between the two days (Alibaba on
 * 17 Aug, Profreight on 18 Aug) and AMAZON_2 does not trade on 18 Aug.
 */
export async function getTablesForDate(eventDate: string): Promise<TableDayRow[]> {
  const rows = await query<TableDayRow>(
    `SELECT td.table_code, td.display_label, td.short_label, td.platform, td.grid_key,
            td.duration_seconds, td.display_order, td.is_active
       FROM table_days td
      WHERE td.event_date = $1
      ORDER BY td.display_order`,
    [eventDate],
  );

  // The room display is a fixed 4x2 grid plus two SHOPEE cards; anything else
  // silently breaks the 1920x1080 layout, so say so loudly in the logs.
  const main = rows.filter((r) => r.grid_key === 'main').length;
  const shopee = rows.filter((r) => r.grid_key === 'shopee').length;
  if (rows.length > 0 && (main !== 8 || shopee !== 2)) {
    logger.warn('Unexpected table roster for date - the room display expects 8 main + 2 shopee', {
      eventDate,
      main,
      shopee,
    });
  }

  return rows;
}

function toTimerState(row: TimerRow): TimerState {
  return {
    timerStatus: row.timer_status,
    durationSeconds: row.duration_seconds,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    endsAt: row.ends_at ? row.ends_at.toISOString() : null,
    pausedRemainingSeconds: row.paused_remaining_seconds,
    timeupAt: row.timeup_at ? row.timeup_at.toISOString() : null,
  };
}

function toPublicAppointment(row: AppointmentRow): PublicAppointment {
  return {
    id: row.id,
    queueNumber: row.queue_number,
    companyName: row.company_name,
    scheduledStart: row.scheduled_start.slice(0, 5),
    scheduledEnd: row.scheduled_end.slice(0, 5),
    tableCode: row.table_code,
    platform: row.platform,
    appointmentStatus: row.appointment_status,
    arrivalStatus: row.arrival_status,
  };
}

/**
 * Eligibility order used everywhere - by the operator's Complete & Next and by
 * the "next / upcoming" lists on the public screens, so the screens always
 * agree with what the next button will actually load.
 *
 * Entrepreneurs who have physically arrived are called before those who have
 * not; within each group the approved schedule order wins.
 */
const ELIGIBLE_ORDER = `
  ORDER BY (arrival_status = 'arrived') DESC, scheduled_start, queue_number, id`;

/**
 * Contact columns are deliberately absent from this SELECT list; only
 * revealContact() ever returns one, so they cannot reach /display or /live even
 * by accident.
 */
async function loadAppointments(eventDate: string): Promise<AppointmentRow[]> {
  return query<AppointmentRow>(
    `SELECT id, event_date, scheduled_start, scheduled_end, platform, table_code,
            queue_number, company_name, appointment_status, arrival_status, slot_id
       FROM appointments
      WHERE event_date = $1
      ORDER BY table_code, scheduled_start, queue_number, id`,
    [eventDate],
  );
}

async function loadTimers(): Promise<TimerRow[]> {
  return query<TimerRow>(
    `SELECT table_code, timer_status, duration_seconds, started_at, ends_at,
            paused_remaining_seconds, current_appointment_id, timeup_at
       FROM timer_states`,
  );
}

const UPCOMING_COUNT = 5;

/** Builds the full payload sent to every screen. */
export async function buildSnapshot(nowMs = Date.now()): Promise<StateSnapshot> {
  const settings = await getSettings();
  const [tables, timers, appointments] = await Promise.all([
    getTablesForDate(settings.active_event_date),
    loadTimers(),
    loadAppointments(settings.active_event_date),
  ]);

  const timerByTable = new Map(timers.map((t) => [t.table_code, t]));
  const byTable = new Map<string, AppointmentRow[]>();
  for (const appointment of appointments) {
    const list = byTable.get(appointment.table_code) ?? [];
    list.push(appointment);
    byTable.set(appointment.table_code, list);
  }

  const snapshots: TableSnapshot[] = tables.map((table) => {
    const timerRow =
      timerByTable.get(table.table_code) ??
      ({
        table_code: table.table_code,
        timer_status: 'ready',
        duration_seconds: table.duration_seconds,
        started_at: null,
        ends_at: null,
        paused_remaining_seconds: null,
        current_appointment_id: null,
        timeup_at: null,
      } satisfies TimerRow);

    // A table that does not trade today always reads as Closed, whatever its
    // timer row happens to say. It still gets a card so the room grid stays 4x2.
    const state = table.is_active
      ? toTimerState(timerRow)
      : { ...toTimerState(timerRow), timerStatus: 'closed' as const };

    const list = byTable.get(table.table_code) ?? [];
    const current = list.find((a) => a.id === timerRow.current_appointment_id) ?? null;

    const eligible = list
      .filter(
        (a) =>
          a.id !== timerRow.current_appointment_id &&
          // slot_id IS NULL means parked: kept in the roster and recallable,
          // but deliberately not callable until placed back on the grid.
          a.slot_id !== null &&
          (a.appointment_status === 'scheduled' || a.appointment_status === 'arrived'),
      )
      .sort(compareEligible);

    const action = table.is_active ? timer.toggleAction(state) : 'blocked';
    const toggleLabel = action === 'pause' ? 'Pause' : action === 'resume' ? 'Resume' : 'Play';

    return {
      tableCode: table.table_code,
      displayLabel: table.display_label,
      shortLabel: table.short_label,
      isActive: table.is_active,
      platform: table.platform,
      zone: table.grid_key,
      durationSeconds: table.duration_seconds,
      durationMinutes: Math.round(table.duration_seconds / 60),
      displayOrder: table.display_order,
      timer: {
        ...state,
        remainingSeconds: timer.remainingSeconds(state, nowMs),
        statusLabel: timer.STATUS_LABELS[state.timerStatus],
        toggleLabel,
        toggleEnabled: action !== 'blocked',
      },
      current: current ? toPublicAppointment(current) : null,
      next: eligible[0] ? toPublicAppointment(eligible[0]) : null,
      upcoming: eligible.slice(0, UPCOMING_COUNT).map(toPublicAppointment),
      stats: {
        completed: list.filter((a) => a.appointment_status === 'completed').length,
        skipped: list.filter((a) => a.appointment_status === 'skipped' || a.appointment_status === 'no_show')
          .length,
        waiting: eligible.length,
        total: list.length,
      },
    };
  });

  return {
    serverTime: nowMs,
    event: {
      name: settings.event_name,
      activeDate: settings.active_event_date,
      eventDates: [...EVENT_DATES],
      timezone: settings.timezone,
      soundEnabled: settings.sound_enabled,
      sessions: EVENT_SESSIONS.map((s) => ({ ...s })),
    },
    tables: snapshots,
    global: timer.globalToggleState(snapshots.map((s) => s.timer)),
    revision,
  };
}

function compareEligible(a: AppointmentRow, b: AppointmentRow): number {
  const arrivedA = a.arrival_status === 'arrived' ? 0 : 1;
  const arrivedB = b.arrival_status === 'arrived' ? 0 : 1;
  if (arrivedA !== arrivedB) return arrivedA - arrivedB;
  if (a.scheduled_start !== b.scheduled_start) return a.scheduled_start < b.scheduled_start ? -1 : 1;
  // The approved roster has no queue numbers, so these are usually both null
  // and the comparison falls through to id, matching ELIGIBLE_ORDER in SQL.
  const qa = a.queue_number ?? '';
  const qb = b.queue_number ?? '';
  if (qa !== qb) {
    const na = Number(qa);
    const nb = Number(qb);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return qa < qb ? -1 : 1;
  }
  return a.id - b.id;
}

// --- writes ---------------------------------------------------------------

async function logOperation(
  client: PoolClient,
  action: string,
  detail: Record<string, unknown> = {},
  tableCode: string | null = null,
  appointmentId: number | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO operation_log (action, table_code, appointment_id, detail)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [action, tableCode, appointmentId, JSON.stringify(detail)],
  );
}

async function lockTimer(
  client: PoolClient,
  tableCode: string,
): Promise<{ row: TimerRow; table: TableRow }> {
  const table = (
    await client.query<TableRow>(
      `SELECT table_code, platform, duration_seconds, zone, display_order
         FROM matching_tables WHERE table_code = $1`,
      [tableCode],
    )
  ).rows[0];
  if (!table) throw new OperationError(`Unknown table "${tableCode}".`, 'not_found');

  const row = (
    await client.query<TimerRow>(
      `SELECT table_code, timer_status, duration_seconds, started_at, ends_at,
              paused_remaining_seconds, current_appointment_id, timeup_at
         FROM timer_states WHERE table_code = $1 FOR UPDATE`,
      [tableCode],
    )
  ).rows[0];
  if (!row) throw new OperationError(`Timer for "${tableCode}" is missing.`, 'not_found');

  return { row, table };
}

async function persistTimer(
  client: PoolClient,
  tableCode: string,
  state: TimerState,
  currentAppointmentId?: number | null,
): Promise<void> {
  const sets = [
    'timer_status = $2',
    'duration_seconds = $3',
    'started_at = $4',
    'ends_at = $5',
    'paused_remaining_seconds = $6',
    'timeup_at = $7',
    'updated_at = now()',
  ];
  const params: unknown[] = [
    tableCode,
    state.timerStatus,
    state.durationSeconds,
    state.startedAt,
    state.endsAt,
    state.pausedRemainingSeconds,
    state.timeupAt,
  ];
  if (currentAppointmentId !== undefined) {
    sets.push(`current_appointment_id = $${params.length + 1}`);
    params.push(currentAppointmentId);
  }
  await client.query(`UPDATE timer_states SET ${sets.join(', ')} WHERE table_code = $1`, params);
}

async function setAppointmentStatus(
  client: PoolClient,
  appointmentId: number,
  status: string,
  arrival?: 'arrived' | 'not_arrived',
): Promise<void> {
  if (arrival) {
    await client.query(
      `UPDATE appointments
          SET appointment_status = $2, arrival_status = $3, updated_at = now()
        WHERE id = $1`,
      [appointmentId, status, arrival],
    );
  } else {
    await client.query(
      `UPDATE appointments SET appointment_status = $2, updated_at = now() WHERE id = $1`,
      [appointmentId, status],
    );
  }
}

async function pickNextEligible(
  client: PoolClient,
  tableCode: string,
  eventDate: string,
  excludeId: number | null,
): Promise<AppointmentRow | null> {
  const rows = (
    await client.query<AppointmentRow>(
      `SELECT id, event_date, scheduled_start, scheduled_end, platform, table_code,
              queue_number, company_name, appointment_status, arrival_status, slot_id
         FROM appointments
        WHERE table_code = $1
          AND event_date = $2
          AND appointment_status IN ('scheduled','arrived')
          AND slot_id IS NOT NULL
          AND ($3::int IS NULL OR id <> $3::int)
        ${ELIGIBLE_ORDER}
        LIMIT 1`,
      [tableCode, eventDate, excludeId],
    )
  ).rows;
  return rows[0] ?? null;
}

/** The one Play/Pause/Resume toggle. */
export async function toggleTimer(tableCode: string): Promise<void> {
  await withTransaction(async (client) => {
    const { row } = await lockTimer(client, tableCode);
    const state = toTimerState(row);
    const action = timer.toggleAction(state);

    if (action === 'blocked') {
      throw new OperationError(
        state.timerStatus === 'timeup'
          ? 'This meeting has finished. Use Complete & Next, or Reset first.'
          : `Table is ${timer.STATUS_LABELS[state.timerStatus]}. Re-open it before starting a timer.`,
      );
    }

    const next = timer.toggle(state, Date.now());
    await persistTimer(client, tableCode, next);

    // Starting a timer is what puts the called entrepreneur "in meeting".
    if (next.timerStatus === 'running' && row.current_appointment_id) {
      await client.query(
        `UPDATE appointments
            SET appointment_status = 'in_meeting', updated_at = now()
          WHERE id = $1 AND appointment_status IN ('scheduled','arrived','called')`,
        [row.current_appointment_id],
      );
    }

    await logOperation(client, `timer.${action}`, { from: state.timerStatus }, tableCode, row.current_appointment_id);
  });
  bumpRevision();
}

/** Resets to the table's default duration. Never advances the queue. */
export async function resetTimer(tableCode: string): Promise<void> {
  await withTransaction(async (client) => {
    const { row, table } = await lockTimer(client, tableCode);
    const state = toTimerState(row);
    await persistTimer(client, tableCode, timer.reset(state, table.duration_seconds));
    await logOperation(
      client,
      'timer.reset',
      { from: state.timerStatus, durationSeconds: table.duration_seconds },
      tableCode,
      row.current_appointment_id,
    );
  });
  bumpRevision();
}

export async function adjustTimer(tableCode: string, deltaSeconds: number): Promise<void> {
  await withTransaction(async (client) => {
    const { row } = await lockTimer(client, tableCode);
    const state = toTimerState(row);
    const next = timer.adjust(state, deltaSeconds, Date.now());
    await persistTimer(client, tableCode, next);
    await logOperation(client, 'timer.adjust', { deltaSeconds }, tableCode, row.current_appointment_id);
  });
  bumpRevision();
}

export async function setTablePresence(
  tableCode: string,
  status: Extract<TimerStatus, 'break' | 'closed' | 'ready'>,
): Promise<void> {
  await withTransaction(async (client) => {
    const { row } = await lockTimer(client, tableCode);
    const state = toTimerState(row);
    await persistTimer(client, tableCode, timer.setPresence(state, status, Date.now()));
    await logOperation(client, 'table.presence', { status }, tableCode, row.current_appointment_id);
  });
  bumpRevision();
}

type AdvanceOutcome = 'completed' | 'skipped' | 'no_show';

/**
 * Closes the current appointment and loads the next eligible one.
 *
 * The next meeting is only *loaded* - the timer is reset and left Ready. It
 * never auto-starts, by design.
 */
async function advance(tableCode: string, outcome: AdvanceOutcome): Promise<{ next: AppointmentRow | null }> {
  const result = await withTransaction(async (client) => {
    const { row, table } = await lockTimer(client, tableCode);
    const settings = (
      await client.query<{ active_event_date: string }>(
        `SELECT active_event_date FROM event_settings WHERE id = 1`,
      )
    ).rows[0];

    if (row.current_appointment_id) {
      // The appointment is never deleted - it stays in the schedule history and
      // a skipped entrepreneur can be recalled later.
      await setAppointmentStatus(client, row.current_appointment_id, outcome);
    }

    const next = await pickNextEligible(
      client,
      tableCode,
      settings.active_event_date,
      row.current_appointment_id,
    );

    if (next) await setAppointmentStatus(client, next.id, 'called');

    const state = toTimerState(row);
    await persistTimer(client, tableCode, timer.reset(state, table.duration_seconds), next?.id ?? null);

    await logOperation(
      client,
      outcome === 'completed' ? 'queue.complete_next' : 'queue.skip_next',
      {
        outcome,
        previousAppointmentId: row.current_appointment_id,
        nextAppointmentId: next?.id ?? null,
        nextQueueNumber: next?.queue_number ?? null,
      },
      tableCode,
      row.current_appointment_id,
    );

    return { next };
  });
  bumpRevision();
  return result;
}

export const completeAndNext = (tableCode: string) => advance(tableCode, 'completed');
export const skipAndNext = (tableCode: string, noShow = false) =>
  advance(tableCode, noShow ? 'no_show' : 'skipped');

/** Puts a skipped / no-show entrepreneur back into the waiting queue. */
export async function recallAppointment(appointmentId: number): Promise<void> {
  await withTransaction(async (client) => {
    const row = (
      await client.query<AppointmentRow>(
        `SELECT id, table_code, appointment_status FROM appointments WHERE id = $1 FOR UPDATE`,
        [appointmentId],
      )
    ).rows[0];
    if (!row) throw new OperationError('Appointment not found.', 'not_found');
    if (row.appointment_status !== 'skipped' && row.appointment_status !== 'no_show') {
      throw new OperationError('Only skipped or no-show appointments can be recalled.');
    }
    await setAppointmentStatus(client, appointmentId, 'arrived', 'arrived');
    await logOperation(client, 'queue.recall', { from: row.appointment_status }, row.table_code, appointmentId);
  });
  bumpRevision();
}

export async function setArrival(appointmentId: number, arrived: boolean): Promise<void> {
  await withTransaction(async (client) => {
    const row = (
      await client.query<AppointmentRow>(
        `SELECT id, table_code, appointment_status FROM appointments WHERE id = $1 FOR UPDATE`,
        [appointmentId],
      )
    ).rows[0];
    if (!row) throw new OperationError('Appointment not found.', 'not_found');
    if (!['scheduled', 'arrived'].includes(row.appointment_status)) {
      throw new OperationError('This appointment has already been called or closed.');
    }
    await setAppointmentStatus(
      client,
      appointmentId,
      arrived ? 'arrived' : 'scheduled',
      arrived ? 'arrived' : 'not_arrived',
    );
    await logOperation(client, 'queue.arrival', { arrived }, row.table_code, appointmentId);
  });
  bumpRevision();
}

/** Manually choose which appointment is loaded next on a table. */
export async function selectCurrent(tableCode: string, appointmentId: number): Promise<void> {
  await withTransaction(async (client) => {
    const { row, table } = await lockTimer(client, tableCode);

    if (row.timer_status === 'running') {
      throw new OperationError('Pause the running timer before changing the queue.');
    }

    const target = (
      await client.query<AppointmentRow>(
        `SELECT id, table_code, appointment_status, arrival_status, queue_number
           FROM appointments WHERE id = $1 FOR UPDATE`,
        [appointmentId],
      )
    ).rows[0];
    if (!target) throw new OperationError('Appointment not found.', 'not_found');
    if (target.table_code !== tableCode) {
      throw new OperationError('That appointment belongs to a different table.');
    }
    if (row.current_appointment_id === appointmentId) return;

    if (row.current_appointment_id) {
      const previous = (
        await client.query<AppointmentRow>(
          `SELECT id, appointment_status, arrival_status FROM appointments WHERE id = $1`,
          [row.current_appointment_id],
        )
      ).rows[0];
      if (previous?.appointment_status === 'in_meeting') {
        throw new OperationError(
          'Finish the current meeting with Complete & Next or Skip & Next first.',
        );
      }
      if (previous?.appointment_status === 'called') {
        await setAppointmentStatus(
          client,
          previous.id,
          previous.arrival_status === 'arrived' ? 'arrived' : 'scheduled',
        );
      }
    }

    if (['completed', 'skipped', 'no_show'].includes(target.appointment_status)) {
      await setAppointmentStatus(client, appointmentId, 'called', 'arrived');
    } else {
      await setAppointmentStatus(client, appointmentId, 'called');
    }

    await persistTimer(
      client,
      tableCode,
      timer.reset(toTimerState(row), table.duration_seconds),
      appointmentId,
    );
    await logOperation(
      client,
      'queue.select',
      { queueNumber: target.queue_number, previousAppointmentId: row.current_appointment_id },
      tableCode,
      appointmentId,
    );
  });
  bumpRevision();
}

// --- global ---------------------------------------------------------------

export async function globalToggle(): Promise<'play' | 'pause'> {
  const action = await withTransaction(async (client) => {
    // Scoped to the tables actually trading today, so Play All never starts a
    // table that is not in the room (Alibaba on day 2) or closed (AMAZON_2).
    const rows = (
      await client.query<TimerRow & { table_duration: number }>(
        `SELECT ts.table_code, ts.timer_status, ts.duration_seconds, ts.started_at, ts.ends_at,
                ts.paused_remaining_seconds, ts.current_appointment_id, ts.timeup_at,
                td.duration_seconds AS table_duration
           FROM timer_states ts
           JOIN table_days td
             ON td.table_code = ts.table_code
            AND td.event_date = (SELECT active_event_date FROM event_settings WHERE id = 1)
          WHERE td.is_active
          ORDER BY td.display_order
          FOR UPDATE OF ts`,
      )
    ).rows;

    const now = Date.now();
    const anyRunning = rows.some((r) => r.timer_status === 'running');

    for (const row of rows) {
      const state = toTimerState(row);
      if (anyRunning) {
        // Pause All only touches running timers.
        if (state.timerStatus !== 'running') continue;
        await persistTimer(client, row.table_code, timer.pause(state, now));
      } else {
        // Play All starts or resumes eligible Ready/Paused timers only.
        if (state.timerStatus !== 'ready' && state.timerStatus !== 'paused') continue;
        if (timer.remainingSeconds(state, now) <= 0) continue;
        await persistTimer(client, row.table_code, timer.start(state, now));
        if (row.current_appointment_id) {
          await client.query(
            `UPDATE appointments SET appointment_status = 'in_meeting', updated_at = now()
              WHERE id = $1 AND appointment_status IN ('scheduled','arrived','called')`,
            [row.current_appointment_id],
          );
        }
      }
    }

    const action: 'play' | 'pause' = anyRunning ? 'pause' : 'play';
    await logOperation(client, `global.${action}`, { tables: rows.length });
    return action;
  });
  bumpRevision();
  return action;
}

export async function globalReset(): Promise<void> {
  await withTransaction(async (client) => {
    const reset = await client.query(
      `UPDATE timer_states ts
          SET timer_status = 'ready',
              duration_seconds = td.duration_seconds,
              started_at = NULL,
              ends_at = NULL,
              paused_remaining_seconds = NULL,
              timeup_at = NULL,
              updated_at = now()
         FROM table_days td
        WHERE td.table_code = ts.table_code
          AND td.event_date = (SELECT active_event_date FROM event_settings WHERE id = 1)
          AND td.is_active`,
    );
    await logOperation(client, 'global.reset_all', { tables: reset.rowCount });
  });
  bumpRevision();
}

export async function setSoundEnabled(enabled: boolean): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE event_settings SET sound_enabled = $1, updated_at = now() WHERE id = 1`,
      [enabled],
    );
    await logOperation(client, 'settings.sound', { enabled });
  });
  bumpRevision();
}

/**
 * Switches the room to the other event day.
 *
 * Every table's loaded appointment belongs to the previous day, so the pointers
 * must be cleared: leaving them in place would make the next Complete & Next
 * mark *yesterday's* appointment completed and then pick today's successor,
 * quietly corrupting the finished day's history.
 */
export async function setActiveDate(date: string): Promise<void> {
  if (!EVENT_DATES.includes(date as (typeof EVENT_DATES)[number])) {
    throw new OperationError(`Event date must be one of ${EVENT_DATES.join(', ')}.`);
  }
  await withTransaction(async (client) => {
    const settings = (
      await client.query<{ active_event_date: string }>(
        `SELECT active_event_date FROM event_settings WHERE id = 1 FOR UPDATE`,
      )
    ).rows[0];
    if (settings.active_event_date === date) return;

    const running = (
      await client.query<{ table_code: string }>(
        `SELECT table_code FROM timer_states WHERE timer_status = 'running'`,
      )
    ).rows;
    if (running.length > 0) {
      throw new OperationError(
        `Pause the running timer${running.length > 1 ? 's' : ''} (${running
          .map((r) => r.table_code)
          .join(', ')}) before switching day.`,
      );
    }

    await client.query(
      `UPDATE timer_states ts
          SET timer_status = 'ready',
              duration_seconds = mt.duration_seconds,
              started_at = NULL,
              ends_at = NULL,
              paused_remaining_seconds = NULL,
              timeup_at = NULL,
              current_appointment_id = NULL,
              event_date = $1,
              updated_at = now()
         FROM matching_tables mt
        WHERE mt.table_code = ts.table_code`,
      [date],
    );
    await client.query(
      `UPDATE event_settings SET active_event_date = $1, updated_at = now() WHERE id = 1`,
      [date],
    );
    await logOperation(client, 'settings.active_date', { date, from: settings.active_event_date });
  });
  bumpRevision();
}

// --- import ---------------------------------------------------------------

export interface ImportResult {
  inserted: number;
  replacedDates: string[];
  preservedCurrent: number;
}

/**
 * Replaces the approved schedule for every date present in the file.
 * Other dates are untouched, so day 2 can be imported without disturbing day 1.
 */
export async function importSchedule(rows: ScheduleRow[]): Promise<ImportResult> {
  const dates = [...new Set(rows.map((r) => r.eventDate))].sort();

  const result = await withTransaction(async (client) => {
    await client.query(
      `UPDATE timer_states SET current_appointment_id = NULL, updated_at = now()
        WHERE current_appointment_id IN (
          SELECT id FROM appointments WHERE event_date = ANY($1::date[])
        )`,
      [dates],
    );
    const deleted = await client.query(`DELETE FROM appointments WHERE event_date = ANY($1::date[])`, [
      dates,
    ]);

    for (const row of rows) {
      await client.query(
        `INSERT INTO appointments
           (event_date, scheduled_start, scheduled_end, platform, table_code,
            queue_number, company_name, appointment_status, arrival_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          row.eventDate,
          row.scheduledStart,
          row.scheduledEnd,
          row.platform,
          row.tableCode,
          row.queueNumber,
          row.companyName,
          row.appointmentStatus,
          row.arrivalStatus,
        ],
      );
    }

    await logOperation(client, 'schedule.import', {
      dates,
      inserted: rows.length,
      removed: deleted.rowCount,
    });

    return { inserted: rows.length, replacedDates: dates, preservedCurrent: 0 };
  });

  bumpRevision();
  logger.info('Schedule imported', { rows: rows.length, dates });
  return result;
}

// --- the editable grid ----------------------------------------------------

export interface GridCellPayload {
  appointmentId: number;
  tableCode: string;
  slotId: number | null;
  slotIndex: number | null;
  queueNumber: string | null;
  companyName: string;
  appointmentStatus: AppointmentStatus;
  arrivalStatus: string;
  rowVersion: number;
  scheduledStart: string;
  isCurrent: boolean;
  frozen: boolean;
  /** True when the appointment is no longer in the cell it was imported into. */
  moved: boolean;
  hasContact: boolean;
}

export interface GridPayload {
  date: string;
  gridRevision: number;
  tables: {
    tableCode: string;
    displayLabel: string;
    shortLabel: string;
    gridKey: 'main' | 'shopee';
    durationMinutes: number;
    displayOrder: number;
    isActive: boolean;
  }[];
  slots: { id: number; gridKey: 'main' | 'shopee'; slotIndex: number; startsAt: string; endsAt: string }[];
  cells: GridCellPayload[];
  parked: GridCellPayload[];
}

interface GridRow extends AppointmentRow {
  slot_index: number | null;
  original_slot_id: number | null;
  row_version: number;
  has_contact: boolean;
}

export async function getGridRevision(): Promise<number> {
  const row = await queryOne<{ grid_revision: string }>(
    `SELECT grid_revision::text FROM event_settings WHERE id = 1`,
  );
  return Number(row?.grid_revision ?? 0);
}

/**
 * The operator's grid for one day.
 *
 * Deliberately reads no contact columns - `has_contact` is a boolean so the UI
 * can show a reveal affordance without the data itself ever being in this
 * payload.
 */
export async function buildGrid(eventDate: string): Promise<GridPayload> {
  const [tables, slots, rows, timers, gridRevision] = await Promise.all([
    getTablesForDate(eventDate),
    query<TimeSlotRow>(
      `SELECT id, event_date, grid_key, slot_index, starts_at, ends_at
         FROM time_slots WHERE event_date = $1 ORDER BY grid_key, slot_index`,
      [eventDate],
    ),
    query<GridRow>(
      `SELECT a.id, a.event_date, a.scheduled_start, a.scheduled_end, a.platform, a.table_code,
              a.queue_number, a.company_name, a.appointment_status, a.arrival_status,
              a.slot_id, a.original_slot_id, a.row_version, s.slot_index,
              -- Existence check only: this yields a boolean so the UI can show a
              -- "reveal" button. No contact VALUE is selected here; revealContact()
              -- is the only function that returns one.
              (a.contact_emails IS NOT NULL OR a.contact_names IS NOT NULL) AS has_contact
         FROM appointments a
         LEFT JOIN time_slots s ON s.id = a.slot_id
        WHERE a.event_date = $1
        ORDER BY a.table_code, s.slot_index NULLS LAST, a.id`,
      [eventDate],
    ),
    loadTimers(),
    getGridRevision(),
  ]);

  const currentIds = new Set(
    timers.map((t) => t.current_appointment_id).filter((id): id is number => id !== null),
  );

  const toCell = (row: GridRow): GridCellPayload => {
    const isCurrent = currentIds.has(row.id);
    return {
      appointmentId: row.id,
      tableCode: row.table_code,
      slotId: row.slot_id,
      slotIndex: row.slot_index,
      queueNumber: row.queue_number,
      companyName: row.company_name,
      appointmentStatus: row.appointment_status,
      arrivalStatus: row.arrival_status,
      rowVersion: row.row_version,
      scheduledStart: row.scheduled_start.slice(0, 5),
      isCurrent,
      frozen: isCurrent || FROZEN_STATUSES.includes(row.appointment_status),
      moved: row.original_slot_id !== null && row.original_slot_id !== row.slot_id,
      hasContact: row.has_contact,
    };
  };

  return {
    date: eventDate,
    gridRevision,
    tables: tables.map((t) => ({
      tableCode: t.table_code,
      displayLabel: t.display_label,
      shortLabel: t.short_label,
      gridKey: t.grid_key,
      durationMinutes: Math.round(t.duration_seconds / 60),
      displayOrder: t.display_order,
      isActive: t.is_active,
    })),
    slots: slots.map((s) => ({
      id: s.id,
      gridKey: s.grid_key,
      slotIndex: s.slot_index,
      startsAt: s.starts_at.slice(0, 5),
      endsAt: s.ends_at.slice(0, 5),
    })),
    cells: rows.filter((r) => r.slot_id !== null).map(toCell),
    parked: rows.filter((r) => r.slot_id === null).map(toCell),
  };
}

// --- grid mutations -------------------------------------------------------

export interface GridMutationResult {
  gridRevision: number;
  date: string;
  changed: number[];
  warnings: string[];
  crossedBreak?: boolean;
}

interface GridAppointmentRow extends AppointmentRow {
  slot_index: number | null;
  row_version: number;
  grid_key: 'main' | 'shopee';
}

/**
 * Serialises all grid mutations against each other.
 *
 * Timer actions deliberately do NOT take this lock, so the room clock is never
 * blocked by an edit; the two paths interlock through timer_states instead.
 */
async function lockGrid(client: PoolClient): Promise<number> {
  const row = (
    await client.query<{ grid_revision: string }>(
      `SELECT grid_revision::text FROM event_settings WHERE id = 1 FOR UPDATE`,
    )
  ).rows[0];
  return Number(row.grid_revision);
}

async function bumpGridRevision(client: PoolClient): Promise<number> {
  const row = (
    await client.query<{ grid_revision: string }>(
      `UPDATE event_settings SET grid_revision = grid_revision + 1, updated_at = now()
        WHERE id = 1 RETURNING grid_revision::text`,
    )
  ).rows[0];
  return Number(row.grid_revision);
}

/** One appointment with everything a grid guard needs, locked for update. */
async function lockAppointment(
  client: PoolClient,
  appointmentId: number,
): Promise<GridAppointmentRow> {
  const row = (
    await client.query<GridAppointmentRow>(
      `SELECT a.id, a.event_date, a.scheduled_start, a.scheduled_end, a.platform, a.table_code,
              a.queue_number, a.company_name, a.appointment_status, a.arrival_status,
              a.slot_id, a.original_slot_id, a.row_version, s.slot_index, td.grid_key
         FROM appointments a
         LEFT JOIN time_slots s ON s.id = a.slot_id
         JOIN table_days td ON td.table_code = a.table_code AND td.event_date = a.event_date
        WHERE a.id = $1
          FOR UPDATE OF a`,
      [appointmentId],
    )
  ).rows[0];
  if (!row) throw new OperationError('That appointment no longer exists.', 'not_found');
  return row;
}

function assertVersion(row: GridAppointmentRow, expected: number | undefined): void {
  if (expected !== undefined && row.row_version !== expected) {
    throw new OperationError(
      'This cell changed in another tab. The grid has been refreshed - please try again.',
      'stale',
    );
  }
}

async function isCurrentAppointment(client: PoolClient, appointmentId: number): Promise<boolean> {
  const row = (
    await client.query(`SELECT 1 FROM timer_states WHERE current_appointment_id = $1`, [appointmentId])
  ).rows[0];
  return Boolean(row);
}

/** Runs the shared guard, including the "is loaded at a table right now" check. */
async function guardEditable(client: PoolClient, row: GridAppointmentRow): Promise<void> {
  const verdict = guardCellEdit({
    appointmentId: row.id,
    tableCode: row.table_code,
    slotIndex: row.slot_index,
    companyName: row.company_name,
    appointmentStatus: row.appointment_status,
    rowVersion: row.row_version,
    isCurrent: await isCurrentAppointment(client, row.id),
  });
  if (!verdict.ok) throw new OperationError(verdict.message);
}

/**
 * The single writer of a cell's position.
 *
 * Also rewrites scheduled_start/end and platform from the destination, because
 * the queue engine orders by scheduled_start and /live labels by platform - a
 * move that updated only slot_id would leave both stale.
 */
async function writeCell(
  client: PoolClient,
  appointmentId: number,
  target: { tableCode: string; slotId: number | null },
): Promise<void> {
  await client.query(
    `UPDATE appointments a
        SET table_code = $2,
            slot_id = $3,
            scheduled_start = COALESCE(s.starts_at, a.scheduled_start),
            scheduled_end   = COALESCE(s.ends_at,   a.scheduled_end),
            platform        = COALESCE(td.platform, a.platform),
            row_version = a.row_version + 1,
            updated_at = now()
       FROM (SELECT 1) AS ignored
       LEFT JOIN time_slots s ON s.id = $3::int
       LEFT JOIN table_days td ON td.table_code = $2 AND td.event_date = (
              SELECT event_date FROM appointments WHERE id = $1)
      WHERE a.id = $1`,
    [appointmentId, target.tableCode, target.slotId],
  );
}

async function loadColumn(
  client: PoolClient,
  eventDate: string,
  tableCode: string,
): Promise<GridAppointmentRow[]> {
  return (
    await client.query<GridAppointmentRow>(
      `SELECT a.id, a.event_date, a.scheduled_start, a.scheduled_end, a.platform, a.table_code,
              a.queue_number, a.company_name, a.appointment_status, a.arrival_status,
              a.slot_id, a.original_slot_id, a.row_version, s.slot_index, td.grid_key
         FROM appointments a
         LEFT JOIN time_slots s ON s.id = a.slot_id
         JOIN table_days td ON td.table_code = a.table_code AND td.event_date = a.event_date
        WHERE a.event_date = $1 AND a.table_code = $2
        ORDER BY s.slot_index NULLS LAST, a.id
          FOR UPDATE OF a`,
      [eventDate, tableCode],
    )
  ).rows;
}

async function tableDayFor(
  client: PoolClient,
  eventDate: string,
  tableCode: string,
): Promise<TableDayRow> {
  const row = (
    await client.query<TableDayRow>(
      `SELECT table_code, display_label, short_label, platform, grid_key, duration_seconds,
              display_order, is_active
         FROM table_days WHERE event_date = $1 AND table_code = $2`,
      [eventDate, tableCode],
    )
  ).rows[0];
  if (!row) throw new OperationError(`${tableCode} does not trade on ${eventDate}.`, 'not_found');
  return row;
}

async function slotById(client: PoolClient, slotId: number): Promise<TimeSlotRow> {
  const row = (
    await client.query<TimeSlotRow>(
      `SELECT id, event_date, grid_key, slot_index, starts_at, ends_at FROM time_slots WHERE id = $1`,
      [slotId],
    )
  ).rows[0];
  if (!row) throw new OperationError('That time slot does not exist.', 'not_found');
  return row;
}

async function occupantOf(
  client: PoolClient,
  eventDate: string,
  tableCode: string,
  slotId: number,
): Promise<GridAppointmentRow | null> {
  const row = (
    await client.query<GridAppointmentRow>(
      `SELECT a.id, a.event_date, a.scheduled_start, a.scheduled_end, a.platform, a.table_code,
              a.queue_number, a.company_name, a.appointment_status, a.arrival_status,
              a.slot_id, a.original_slot_id, a.row_version, s.slot_index, td.grid_key
         FROM appointments a
         JOIN time_slots s ON s.id = a.slot_id
         JOIN table_days td ON td.table_code = a.table_code AND td.event_date = a.event_date
        WHERE a.event_date = $1 AND a.table_code = $2 AND a.slot_id = $3
          FOR UPDATE OF a`,
      [eventDate, tableCode, slotId],
    )
  ).rows[0];
  return row ?? null;
}

/**
 * Warns when an edit leaves one company due at two tables at once.
 *
 * This is reported, never refused: the operator may genuinely need to do it,
 * and silence would create a real double-booking nobody noticed.
 */
async function overlapWarnings(
  client: PoolClient,
  eventDate: string,
  appointmentIds: number[],
): Promise<string[]> {
  if (appointmentIds.length === 0) return [];
  const rows = (
    await client.query<{ company_name: string; scheduled_start: string; tables: string }>(
      `SELECT b.company_name, b.scheduled_start, string_agg(DISTINCT b.table_code, ', ') AS tables
         FROM appointments a
         JOIN appointments b
           ON b.event_date = a.event_date
          AND b.company_name = a.company_name
          AND b.slot_id IS NOT NULL
          AND b.appointment_status NOT IN ('completed','skipped','no_show')
          AND tsrange(('2000-01-01 ' || b.scheduled_start)::timestamp,
                      ('2000-01-01 ' || b.scheduled_end)::timestamp)
              && tsrange(('2000-01-01 ' || a.scheduled_start)::timestamp,
                         ('2000-01-01 ' || a.scheduled_end)::timestamp)
        WHERE a.id = ANY($1::int[]) AND a.event_date = $2 AND a.slot_id IS NOT NULL
        GROUP BY b.company_name, b.scheduled_start
       HAVING count(DISTINCT b.table_code) > 1`,
      [appointmentIds, eventDate],
    )
  ).rows;

  return rows.map(
    (r) => `${r.company_name} is now due at ${r.tables} around ${r.scheduled_start.slice(0, 5)}.`,
  );
}

/**
 * Marks a cell as a no-show, optionally pulling the rest of that column up.
 *
 * `push` defaults to false, and that default matters. The approved roster is
 * built so no company is ever due at two tables at once; shifting a whole
 * column earlier breaks that for everyone below the gap, and a single no-show
 * at a busy table can produce a dozen fresh clashes. Without a push, the queue
 * engine simply calls the next company early and the rest of the day keeps its
 * planned times - which is what usually happens in the room anyway.
 */
export async function noShowAndPush(
  appointmentId: number,
  expectedVersion?: number,
  push = false,
): Promise<GridMutationResult> {
  const result = await withTransaction(async (client) => {
    await lockGrid(client);
    const target = await lockAppointment(client, appointmentId);
    assertVersion(target, expectedVersion);
    await lockTimer(client, target.table_code);
    await guardEditable(client, target);
    if (target.slot_id === null || target.slot_index === null) {
      throw new OperationError('That appointment is already parked.');
    }

    const column = await loadColumn(client, target.event_date, target.table_code);
    const slots = (
      await client.query<TimeSlotRow>(
        `SELECT id, event_date, grid_key, slot_index, starts_at, ends_at
           FROM time_slots WHERE event_date = $1 AND grid_key = $2 ORDER BY slot_index`,
        [target.event_date, target.grid_key],
      )
    ).rows;
    const slotByIndex = new Map(slots.map((s) => [s.slot_index, s]));

    const currentId = (
      await client.query<{ current_appointment_id: number | null }>(
        `SELECT current_appointment_id FROM timer_states WHERE table_code = $1`,
        [target.table_code],
      )
    ).rows[0]?.current_appointment_id;

    const cells = column.map((row) => ({
      appointmentId: row.id,
      tableCode: row.table_code,
      slotIndex: row.slot_index,
      companyName: row.company_name,
      appointmentStatus: row.appointment_status,
      rowVersion: row.row_version,
      isCurrent: row.id === currentId,
    }));

    // Park the no-show first so its row is free to be filled.
    await client.query(
      `UPDATE appointments
          SET appointment_status = 'no_show', arrival_status = 'not_arrived',
              slot_id = NULL, row_version = row_version + 1, updated_at = now()
        WHERE id = $1`,
      [appointmentId],
    );

    const plan = push
      ? planCompaction(
          cells.filter((c) => c.appointmentId !== appointmentId),
          target.slot_index,
          slots.map((s) => s.starts_at.slice(0, 5)),
        )
      : { moves: [], crossedBreak: false };

    // Two phases: a partial unique index cannot be deferred, so every mover is
    // detached before any of them lands, or the shuffle collides mid-update.
    for (const move of plan.moves) {
      await client.query(
        `UPDATE appointments SET slot_id = NULL, updated_at = now() WHERE id = $1`,
        [move.appointmentId],
      );
    }
    for (const move of plan.moves) {
      const slot = slotByIndex.get(move.toSlotIndex);
      if (!slot) continue;
      await writeCell(client, move.appointmentId, { tableCode: target.table_code, slotId: slot.id });
    }

    const changed = [appointmentId, ...plan.moves.map((m) => m.appointmentId)];
    const warnings = await overlapWarnings(client, target.event_date, changed);
    if (plan.crossedBreak) {
      warnings.push('One or more meetings moved across a break in the day - please check the times.');
    }

    await logOperation(
      client,
      push ? 'grid.no_show_push' : 'grid.no_show',
      { moved: plan.moves.length, crossedBreak: plan.crossedBreak, clashes: warnings.length },
      target.table_code,
      appointmentId,
    );
    const gridRevision = await bumpGridRevision(client);
    return { gridRevision, date: target.event_date, changed, warnings, crossedBreak: plan.crossedBreak };
  });
  bumpRevision();
  return result;
}

/** Moves an appointment to an empty cell, or parks it when slotId is null. */
export async function moveCell(
  appointmentId: number,
  toTableCode: string,
  toSlotId: number | null,
  expectedVersion?: number,
): Promise<GridMutationResult> {
  const result = await withTransaction(async (client) => {
    await lockGrid(client);
    const row = await lockAppointment(client, appointmentId);
    assertVersion(row, expectedVersion);

    // Deterministic lock order over the affected tables prevents two operators
    // swapping A->B and B->A from deadlocking.
    for (const code of [...new Set([row.table_code, toTableCode])].sort()) {
      await lockTimer(client, code);
    }
    await guardEditable(client, row);

    if (toSlotId === null) {
      await writeCell(client, appointmentId, { tableCode: row.table_code, slotId: null });
      await logOperation(client, 'grid.park', {}, row.table_code, appointmentId);
      const gridRevision = await bumpGridRevision(client);
      return { gridRevision, date: row.event_date, changed: [appointmentId], warnings: [] };
    }

    const destination = await tableDayFor(client, row.event_date, toTableCode);
    const slot = await slotById(client, toSlotId);

    const allowed = canMoveBetween(row.grid_key, destination.grid_key, destination.is_active);
    if (!allowed.ok) throw new OperationError(allowed.message, 'grid_mismatch');
    if (slot.event_date !== row.event_date || slot.grid_key !== destination.grid_key) {
      throw new OperationError('That slot is not on the destination grid.', 'bad_request');
    }

    const occupant = await occupantOf(client, row.event_date, toTableCode, toSlotId);
    if (occupant && occupant.id !== appointmentId) {
      throw new OperationError(
        `${occupant.company_name} is already in that cell. Swap them instead.`,
        'occupied',
      );
    }

    await writeCell(client, appointmentId, { tableCode: toTableCode, slotId: toSlotId });
    const warnings = await overlapWarnings(client, row.event_date, [appointmentId]);
    await logOperation(
      client,
      'grid.move',
      { from: `${row.table_code}@${row.slot_index}`, to: `${toTableCode}@${slot.slot_index}` },
      toTableCode,
      appointmentId,
    );
    const gridRevision = await bumpGridRevision(client);
    return { gridRevision, date: row.event_date, changed: [appointmentId], warnings };
  });
  bumpRevision();
  return result;
}

/** Exchanges the cells of two appointments. */
export async function swapCells(
  firstId: number,
  secondId: number,
  versions?: { first?: number; second?: number },
): Promise<GridMutationResult> {
  if (firstId === secondId) throw new OperationError('Pick two different cells.', 'bad_request');

  const result = await withTransaction(async (client) => {
    await lockGrid(client);
    // Lock in a stable id order so two concurrent swaps cannot deadlock.
    const [lowId, highId] = [firstId, secondId].sort((a, b) => a - b);
    const low = await lockAppointment(client, lowId);
    const high = await lockAppointment(client, highId);
    const a = lowId === firstId ? low : high;
    const b = lowId === firstId ? high : low;

    assertVersion(a, versions?.first);
    assertVersion(b, versions?.second);

    for (const code of [...new Set([a.table_code, b.table_code])].sort()) {
      await lockTimer(client, code);
    }
    await guardEditable(client, a);
    await guardEditable(client, b);

    if (a.event_date !== b.event_date) {
      throw new OperationError('Both cells must be on the same day.', 'bad_request');
    }
    if (a.grid_key !== b.grid_key) {
      throw new OperationError(
        canMoveBetween(a.grid_key, b.grid_key, true).ok
          ? 'Those cells are on different grids.'
          : (canMoveBetween(a.grid_key, b.grid_key, true) as { message: string }).message,
        'grid_mismatch',
      );
    }

    const aTarget = { tableCode: b.table_code, slotId: b.slot_id };
    const bTarget = { tableCode: a.table_code, slotId: a.slot_id };

    // Detach both before re-placing either: the cell uniqueness index is
    // partial and therefore cannot be deferred to commit time.
    await client.query(`UPDATE appointments SET slot_id = NULL WHERE id = ANY($1::int[])`, [
      [a.id, b.id],
    ]);
    await writeCell(client, a.id, aTarget);
    await writeCell(client, b.id, bTarget);

    const warnings = await overlapWarnings(client, a.event_date, [a.id, b.id]);
    await logOperation(
      client,
      'grid.swap',
      { a: `${a.table_code}@${a.slot_index}`, b: `${b.table_code}@${b.slot_index}` },
      a.table_code,
      a.id,
    );
    const gridRevision = await bumpGridRevision(client);
    return { gridRevision, date: a.event_date, changed: [a.id, b.id], warnings };
  });
  bumpRevision();
  return result;
}

/** Clears a cell: the appointment is parked, not deleted. */
export async function clearCell(
  appointmentId: number,
  expectedVersion?: number,
): Promise<GridMutationResult> {
  const result = await withTransaction(async (client) => {
    await lockGrid(client);
    const row = await lockAppointment(client, appointmentId);
    assertVersion(row, expectedVersion);
    await lockTimer(client, row.table_code);
    await guardEditable(client, row);

    await client.query(
      `UPDATE appointments
          SET slot_id = NULL, appointment_status = 'scheduled',
              row_version = row_version + 1, updated_at = now()
        WHERE id = $1`,
      [appointmentId],
    );
    await logOperation(client, 'grid.clear', { from: row.slot_index }, row.table_code, appointmentId);
    const gridRevision = await bumpGridRevision(client);
    return { gridRevision, date: row.event_date, changed: [appointmentId], warnings: [] };
  });
  bumpRevision();
  return result;
}

/**
 * Corrects the company name in a cell.
 *
 * Allowed even while that table is mid-meeting: it changes no identity and no
 * ordering, so a typo can always be fixed.
 */
export async function renameCell(
  appointmentId: number,
  companyName: string,
): Promise<GridMutationResult> {
  const trimmed = companyName.trim();
  if (!trimmed) throw new OperationError('A company name is required.', 'bad_request');
  if (trimmed.length > 300) throw new OperationError('That name is too long.', 'bad_request');

  const result = await withTransaction(async (client) => {
    await lockGrid(client);
    const row = await lockAppointment(client, appointmentId);
    await client.query(
      `UPDATE appointments SET company_name = $2, row_version = row_version + 1, updated_at = now()
        WHERE id = $1`,
      [appointmentId, trimmed],
    );
    await logOperation(
      client,
      'grid.rename',
      { from: row.company_name, to: trimmed },
      row.table_code,
      appointmentId,
    );
    const gridRevision = await bumpGridRevision(client);
    return { gridRevision, date: row.event_date, changed: [appointmentId], warnings: [] };
  });
  bumpRevision();
  return result;
}

/** Reads the contact details for one appointment, and records that it happened. */
export async function revealContact(appointmentId: number): Promise<{
  companyName: string;
  contactNames: string | null;
  contactEmails: string | null;
  province: string | null;
  productCategory: string | null;
}> {
  return withTransaction(async (client) => {
    // The one and only place contact columns are selected.
    const row = (
      await client.query<{
        company_name: string;
        contact_names: string | null;
        contact_emails: string | null;
        province: string | null;
        product_category: string | null;
        table_code: string;
      }>(
        `SELECT company_name, contact_names, contact_emails, province, product_category, table_code
           FROM appointments WHERE id = $1`,
        [appointmentId],
      )
    ).rows[0];
    if (!row) throw new OperationError('That appointment no longer exists.', 'not_found');

    await logOperation(client, 'contact.view', {}, row.table_code, appointmentId);
    return {
      companyName: row.company_name,
      contactNames: row.contact_names,
      contactEmails: row.contact_emails,
      province: row.province,
      productCategory: row.product_category,
    };
  });
}

// --- approved roster import (xlsx) ----------------------------------------

export interface RosterImportResult {
  inserted: number;
  dates: string[];
  removed: number;
  parked: number;
}

/** Slot and per-day-table lookups the roster validator needs. */
export async function loadRosterContext(): Promise<RosterValidationContext> {
  const [dayRows, slots] = await Promise.all([
    // Every day at once: the validator checks each row against its own date.
    query<TableDayRow & { event_date: string }>(
      `SELECT event_date, table_code, display_label, short_label, platform, grid_key,
              duration_seconds, display_order, is_active
         FROM table_days`,
    ),
    query<TimeSlotRow>(
      `SELECT id, event_date, grid_key, slot_index, starts_at, ends_at FROM time_slots`,
    ),
  ]);

  return {
    tableDays: new Map(dayRows.map((d) => [tableDayKey(d.event_date, d.table_code), d])),
    slots: new Map(slots.map((s) => [slotKey(s.event_date, s.grid_key, s.starts_at), s])),
  };
}

/**
 * Replaces the approved roster for every date present in the file.
 *
 * Other dates are untouched, so day 2 can be re-imported mid-event without
 * disturbing day 1's history.
 */
export async function importRoster(rows: RosterRow[]): Promise<RosterImportResult> {
  const dates = [...new Set(rows.map((r) => r.eventDate))].sort();

  const result = await withTransaction(async (client) => {
    const days = (
      await client.query<TableDayRow & { event_date: string }>(
        `SELECT event_date, table_code, display_label, short_label, platform, grid_key,
                duration_seconds, display_order, is_active
           FROM table_days WHERE event_date = ANY($1::date[])`,
        [dates],
      )
    ).rows;
    const dayByKey = new Map(days.map((d) => [tableDayKey(d.event_date, d.table_code), d]));

    const slots = (
      await client.query<TimeSlotRow>(
        `SELECT id, event_date, grid_key, slot_index, starts_at, ends_at
           FROM time_slots WHERE event_date = ANY($1::date[])`,
        [dates],
      )
    ).rows;
    const slotByKey = new Map(slots.map((s) => [slotKey(s.event_date, s.grid_key, s.starts_at), s]));

    // Detach timers first so the delete cannot orphan a pointer.
    await client.query(
      `UPDATE timer_states SET current_appointment_id = NULL, updated_at = now()
        WHERE current_appointment_id IN (
          SELECT id FROM appointments WHERE event_date = ANY($1::date[])
        )`,
      [dates],
    );
    const deleted = await client.query(
      `DELETE FROM appointments WHERE event_date = ANY($1::date[])`,
      [dates],
    );

    let parked = 0;
    for (const row of rows) {
      const day = dayByKey.get(tableDayKey(row.eventDate, row.tableCode));
      if (!day) throw new OperationError(`No roster entry for ${row.tableCode} on ${row.eventDate}.`);
      const slot = slotByKey.get(slotKey(row.eventDate, day.grid_key, row.startTime));
      if (!slot) parked += 1;

      await client.query(
        `INSERT INTO appointments
           (event_date, scheduled_start, scheduled_end, platform, table_code, queue_number,
            company_name, appointment_status, arrival_status, slot_id, original_slot_id,
            contact_names, contact_emails, province, product_category, priority_group)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'scheduled','not_arrived',$8,$8,$9,$10,$11,$12,$13)`,
        [
          row.eventDate,
          row.startTime,
          row.endTime,
          row.platform || day.platform,
          row.tableCode,
          slot ? queueNumberFor(day.display_order, slot.slot_index) : null,
          row.companyName,
          slot ? slot.id : null,
          row.contactNames,
          row.contactEmails,
          row.province,
          row.productCategory,
          row.priorityGroup,
        ],
      );
    }

    await client.query(
      `UPDATE event_settings SET grid_revision = grid_revision + 1, updated_at = now() WHERE id = 1`,
    );
    await logOperation(client, 'roster.import', {
      dates,
      inserted: rows.length,
      removed: deleted.rowCount,
      parked,
    });

    return { inserted: rows.length, dates, removed: deleted.rowCount ?? 0, parked };
  });

  bumpRevision();
  logger.info('Roster imported', result);
  return result;
}

/**
 * The live schedule for one day, in the workbook's row shape.
 *
 * Reads no contact columns - see the export route for why.
 */
export async function exportSchedule(eventDate: string) {
  const rows = await query<{
    event_date: string;
    scheduled_start: string;
    scheduled_end: string;
    platform: string;
    display_label: string;
    queue_number: string | null;
    company_name: string;
    appointment_status: string;
    arrival_status: string;
    slot_id: number | null;
    original_slot_id: number | null;
    display_order: number;
    slot_index: number | null;
  }>(
    `SELECT a.event_date, a.scheduled_start, a.scheduled_end, a.platform, td.display_label,
            a.queue_number, a.company_name, a.appointment_status, a.arrival_status,
            a.slot_id, a.original_slot_id, td.display_order, s.slot_index
       FROM appointments a
       JOIN table_days td ON td.table_code = a.table_code AND td.event_date = a.event_date
       LEFT JOIN time_slots s ON s.id = a.slot_id
      WHERE a.event_date = $1
      ORDER BY s.slot_index NULLS LAST, td.display_order`,
    [eventDate],
  );

  return rows.map((r) => ({
    eventDate: r.event_date,
    scheduledStart: r.scheduled_start.slice(0, 5),
    scheduledEnd: r.scheduled_end.slice(0, 5),
    platform: r.platform,
    tableLabel: r.display_label,
    queueNumber: r.queue_number,
    companyName: r.company_name,
    appointmentStatus: r.appointment_status,
    arrivalStatus: r.arrival_status,
    moved: r.original_slot_id !== null && r.original_slot_id !== r.slot_id,
  }));
}

// --- authoritative expiry tick -------------------------------------------

/**
 * Flips running timers that have passed `ends_at` to `timeup`. This is the only
 * background job that touches timers, and it does not decrement anything - it
 * just records the transition the clock already made.
 */
export async function expireFinishedTimers(nowMs = Date.now()): Promise<string[]> {
  const rows = await query<{ table_code: string }>(
    `UPDATE timer_states
        SET timer_status = 'timeup',
            paused_remaining_seconds = 0,
            timeup_at = COALESCE(timeup_at, now()),
            updated_at = now()
      WHERE timer_status = 'running'
        AND ends_at IS NOT NULL
        AND ends_at <= to_timestamp($1 / 1000.0)
      RETURNING table_code`,
    [nowMs],
  );
  if (rows.length > 0) bumpRevision();
  return rows.map((r) => r.table_code);
}

/** Recent operator actions, newest first (used by the control page). */
export async function recentOperations(limit = 30) {
  return query(
    `SELECT id, occurred_at, action, table_code, appointment_id, detail
       FROM operation_log ORDER BY occurred_at DESC, id DESC LIMIT $1`,
    [limit],
  );
}

/** Full appointment list for the operator's queue panel. */
export async function appointmentsForDate(eventDate: string): Promise<PublicAppointment[]> {
  const rows = await loadAppointments(eventDate);
  return rows.map(toPublicAppointment);
}
