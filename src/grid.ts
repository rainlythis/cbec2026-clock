/**
 * Pure logic for the editable time x table grid.
 *
 * Kept free of SQL for the same reason src/timer.ts is: the rules that decide
 * what may move, and where it lands, are the part that must be provably right,
 * so they are unit tested directly.
 */

import type { AppointmentStatus } from './types';

/**
 * A cell as the grid editor sees it. `slotIndex` is the row, and null means the
 * appointment is parked - in the roster but off the grid.
 */
export interface GridCell {
  appointmentId: number;
  tableCode: string;
  slotIndex: number | null;
  companyName: string;
  appointmentStatus: AppointmentStatus;
  rowVersion: number;
  /** True when this appointment is the one loaded at its table right now. */
  isCurrent: boolean;
}

/**
 * Statuses that pin an appointment to its cell.
 *
 * Anything that has been called or has already happened is history: it may be
 * stepped past by a compaction, but it is never moved, renumbered or deleted.
 */
export const FROZEN_STATUSES: readonly AppointmentStatus[] = [
  'called',
  'in_meeting',
  'completed',
  'skipped',
  'no_show',
];

export function isFrozen(cell: GridCell): boolean {
  return cell.isCurrent || FROZEN_STATUSES.includes(cell.appointmentStatus);
}

/**
 * The first row of a column that a compaction is allowed to touch: one past the
 * deepest frozen cell.
 *
 * This single rule makes every awkward case come out right - a live meeting is
 * never pulled from under a running timer, a completed meeting is never
 * rewritten, and a table part way through its day compacts only its future.
 */
export function firstMovableSlotIndex(column: GridCell[]): number {
  let deepest = -1;
  for (const cell of column) {
    if (cell.slotIndex === null) continue;
    if (isFrozen(cell) && cell.slotIndex > deepest) deepest = cell.slotIndex;
  }
  return deepest + 1;
}

export interface CompactionMove {
  appointmentId: number;
  fromSlotIndex: number;
  toSlotIndex: number;
}

export interface CompactionPlan {
  moves: CompactionMove[];
  /** True when at least one company is pulled across a break in the day. */
  crossedBreak: boolean;
}

/**
 * Closes the gap left at `vacatedSlotIndex` by pulling every later movable
 * appointment in the column up into the next free row.
 *
 * Rows are addressed by slot INDEX, not by clock time, so an irregular grid
 * (SHOPEE skipping 10:50, the main grid breaking for lunch) compacts by
 * position exactly as the operator sees it on screen.
 */
export function planCompaction(
  column: GridCell[],
  vacatedSlotIndex: number,
  slotStartTimes: string[] = [],
): CompactionPlan {
  const floor = firstMovableSlotIndex(column);
  if (vacatedSlotIndex < floor) return { moves: [], crossedBreak: false };

  const movable = column
    .filter(
      (cell): cell is GridCell & { slotIndex: number } =>
        cell.slotIndex !== null && cell.slotIndex > vacatedSlotIndex && !isFrozen(cell),
    )
    .sort((a, b) => a.slotIndex - b.slotIndex);

  const moves: CompactionMove[] = [];
  // Occupied rows that cannot be used as a landing spot.
  const blocked = new Set(
    column
      .filter((cell) => cell.slotIndex !== null && isFrozen(cell))
      .map((cell) => cell.slotIndex as number),
  );

  let target = vacatedSlotIndex;
  for (const cell of movable) {
    while (blocked.has(target)) target += 1;
    if (target >= cell.slotIndex) {
      // Nothing to gain; this one and everything after it is already compact.
      target = cell.slotIndex + 1;
      continue;
    }
    moves.push({ appointmentId: cell.appointmentId, fromSlotIndex: cell.slotIndex, toSlotIndex: target });
    target += 1;
  }

  return { moves, crossedBreak: crossesBreak(moves, slotStartTimes) };
}

/**
 * True when a move pulls a company over a gap in the clock - on the main grid
 * 11:45 and 13:00 are adjacent slot indexes but an hour apart, so a compaction
 * can quietly move somebody's meeting to before lunch.
 */
export function crossesBreak(moves: CompactionMove[], slotStartTimes: string[]): boolean {
  if (slotStartTimes.length === 0) return false;
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));

  return moves.some((move) => {
    const from = slotStartTimes[move.fromSlotIndex];
    const to = slotStartTimes[move.toSlotIndex];
    if (!from || !to) return false;
    // Any jump larger than twice a normal step means a gap was crossed.
    for (let i = move.toSlotIndex; i < move.fromSlotIndex; i += 1) {
      const a = slotStartTimes[i];
      const b = slotStartTimes[i + 1];
      if (a && b && minutes(b) - minutes(a) > 20) return true;
    }
    return false;
  });
}

/** Why a grid edit was refused. Surfaced verbatim to the operator. */
export type CellGuardReason =
  | { ok: true }
  | { ok: false; code: 'current'; message: string }
  | { ok: false; code: 'in_progress'; message: string }
  | { ok: false; code: 'history'; message: string };

/**
 * The one gate every grid mutation passes through.
 *
 * Renaming the company in a cell is deliberately NOT routed through here: it
 * changes no identity and no ordering, so a typo can be fixed even at a table
 * that is mid-meeting.
 */
export function guardCellEdit(cell: GridCell): CellGuardReason {
  if (cell.isCurrent) {
    return {
      ok: false,
      code: 'current',
      message: `${cell.companyName} is loaded at ${cell.tableCode} right now. Use Complete & Next or Skip & Next first.`,
    };
  }
  if (cell.appointmentStatus === 'called' || cell.appointmentStatus === 'in_meeting') {
    return {
      ok: false,
      code: 'in_progress',
      message: `${cell.companyName} has already been called to ${cell.tableCode}.`,
    };
  }
  if (FROZEN_STATUSES.includes(cell.appointmentStatus)) {
    return {
      ok: false,
      code: 'history',
      message: `${cell.companyName} is already ${cell.appointmentStatus.replace('_', ' ')} and stays in the record. Recall them instead.`,
    };
  }
  return { ok: true };
}

/**
 * Whether an appointment may move between two tables.
 *
 * A move across grids is refused rather than silently reshaped: 10:45 exists on
 * the main grid and not on SHOPEE, and swapping would turn one company's
 * 15-minute meeting into a 10-minute one without anybody deciding to.
 */
export function canMoveBetween(
  fromGridKey: string,
  toGridKey: string,
  toIsActive: boolean,
): { ok: true } | { ok: false; message: string } {
  if (!toIsActive) {
    return { ok: false, message: 'That table is closed for the day. Re-open it first.' };
  }
  if (fromGridKey !== toGridKey) {
    return {
      ok: false,
      message:
        'SHOPEE runs a 10-minute grid and the other tables run 15 minutes, so the rows do not line up. ' +
        'Clear the cell and place the company on the other grid instead.',
    };
  }
  return { ok: true };
}
