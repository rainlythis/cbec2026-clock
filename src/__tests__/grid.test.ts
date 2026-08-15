import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canMoveBetween,
  firstMovableSlotIndex,
  guardCellEdit,
  isFrozen,
  planCompaction,
  type GridCell,
} from '../grid';
import type { AppointmentStatus } from '../types';

let nextId = 1;

function cell(
  slotIndex: number | null,
  status: AppointmentStatus = 'scheduled',
  isCurrent = false,
): GridCell {
  return {
    appointmentId: nextId++,
    tableCode: 'THPM',
    slotIndex,
    companyName: `Company ${slotIndex}`,
    appointmentStatus: status,
    rowVersion: 1,
    isCurrent,
  };
}

/** A tidy column of `count` waiting appointments in slots 0..count-1. */
function column(count: number): GridCell[] {
  return Array.from({ length: count }, (_, i) => cell(i));
}

describe('frozen cells', () => {
  it('treats anything called or finished as frozen', () => {
    assert.equal(isFrozen(cell(0, 'called')), true);
    assert.equal(isFrozen(cell(0, 'in_meeting')), true);
    assert.equal(isFrozen(cell(0, 'completed')), true);
    assert.equal(isFrozen(cell(0, 'skipped')), true);
    assert.equal(isFrozen(cell(0, 'no_show')), true);
  });

  it('treats the loaded appointment as frozen whatever its status', () => {
    assert.equal(isFrozen(cell(3, 'arrived', true)), true);
  });

  it('leaves waiting appointments movable', () => {
    assert.equal(isFrozen(cell(0, 'scheduled')), false);
    assert.equal(isFrozen(cell(0, 'arrived')), false);
  });
});

describe('the frozen prefix', () => {
  it('is the whole column when nothing has happened yet', () => {
    assert.equal(firstMovableSlotIndex(column(5)), 0);
  });

  it('starts one past the deepest finished meeting', () => {
    const col = [cell(0, 'completed'), cell(1, 'completed'), cell(2), cell(3)];
    assert.equal(firstMovableSlotIndex(col), 2);
  });

  it('protects a live meeting sitting mid-column', () => {
    const col = [cell(0, 'completed'), cell(1), cell(2, 'in_meeting'), cell(3), cell(4)];
    assert.equal(firstMovableSlotIndex(col), 3);
  });

  it('ignores parked appointments', () => {
    const col = [cell(0, 'completed'), cell(null, 'no_show'), cell(1)];
    assert.equal(firstMovableSlotIndex(col), 1);
  });
});

describe('compaction', () => {
  it('pulls every later appointment up one row', () => {
    const col = column(5);
    const plan = planCompaction(col.filter((c) => c.slotIndex !== 1), 1);
    assert.deepEqual(
      plan.moves.map((m) => [m.fromSlotIndex, m.toSlotIndex]),
      [[2, 1], [3, 2], [4, 3]],
    );
  });

  it('does nothing when the last row is vacated', () => {
    const col = column(4);
    assert.deepEqual(planCompaction(col.filter((c) => c.slotIndex !== 3), 3).moves, []);
  });

  it('never moves anything into or past a finished meeting', () => {
    // slots 0-1 done, 2 vacated, 3-4 waiting
    const col = [cell(0, 'completed'), cell(1, 'completed'), cell(3), cell(4)];
    const plan = planCompaction(col, 2);
    assert.deepEqual(plan.moves.map((m) => [m.fromSlotIndex, m.toSlotIndex]), [[3, 2], [4, 3]]);
  });

  it('refuses to compact into the frozen prefix', () => {
    // Trying to fill slot 0 when slot 2 is mid-meeting must be a no-op.
    const col = [cell(1), cell(2, 'in_meeting'), cell(3)];
    assert.deepEqual(planCompaction(col, 0).moves, []);
  });

  it('will not pull anybody backwards past a meeting already called', () => {
    // slot 1 vacated, but slot 2 has already been called. That gap is in the
    // past as far as the room is concerned, so filling it would schedule
    // somebody ahead of a company that has already been called up.
    const col = [cell(0, 'completed'), cell(2, 'called'), cell(3), cell(4)];
    assert.deepEqual(planCompaction(col, 1).moves, []);
  });

  it('compacts normally once the gap is below everything frozen', () => {
    const col = [cell(0, 'completed'), cell(1, 'called'), cell(3), cell(4)];
    const plan = planCompaction(col, 2);
    assert.deepEqual(plan.moves.map((m) => [m.fromSlotIndex, m.toSlotIndex]), [[3, 2], [4, 3]]);
  });

  it('leaves a column with no movers alone', () => {
    const col = [cell(0, 'completed'), cell(1, 'completed')];
    assert.deepEqual(planCompaction(col, 2).moves, []);
  });

  it('flags a move that crosses a break in the day', () => {
    // The main grid runs 11:45 then 13:00: adjacent slots, an hour apart.
    const times = ['11:15', '11:30', '11:45', '13:00', '13:15'];
    const col = [cell(0), cell(1), cell(3), cell(4)];
    const plan = planCompaction(col, 2, times);
    assert.equal(plan.crossedBreak, true);
  });

  it('does not flag a break when the moves stay inside one session', () => {
    const times = ['10:00', '10:15', '10:30', '10:45', '11:00'];
    const col = [cell(0), cell(2), cell(3)];
    assert.equal(planCompaction(col, 1, times).crossedBreak, false);
  });
});

describe('the cell guard', () => {
  it('refuses to touch the appointment loaded at a table', () => {
    const verdict = guardCellEdit(cell(2, 'arrived', true));
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.code, 'current');
      assert.match(verdict.message, /Complete & Next or Skip & Next/);
    }
  });

  it('refuses an appointment already called', () => {
    const verdict = guardCellEdit(cell(2, 'called'));
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, 'in_progress');
  });

  it('refuses to rewrite history', () => {
    for (const status of ['completed', 'skipped', 'no_show'] as AppointmentStatus[]) {
      const verdict = guardCellEdit(cell(2, status));
      assert.equal(verdict.ok, false, status);
      if (!verdict.ok) assert.equal(verdict.code, 'history');
    }
  });

  it('allows a waiting appointment to be edited', () => {
    assert.equal(guardCellEdit(cell(2, 'scheduled')).ok, true);
    assert.equal(guardCellEdit(cell(2, 'arrived')).ok, true);
  });
});

describe('move rules', () => {
  it('allows a move between two tables on the same grid', () => {
    assert.equal(canMoveBetween('main', 'main', true).ok, true);
    assert.equal(canMoveBetween('shopee', 'shopee', true).ok, true);
  });

  it('refuses a move between the 15 and 10 minute grids', () => {
    const verdict = canMoveBetween('main', 'shopee', true);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.match(verdict.message, /10-minute grid/);
  });

  it('refuses a move onto a table closed for the day', () => {
    const verdict = canMoveBetween('main', 'main', false);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.match(verdict.message, /closed for the day/);
  });
});
