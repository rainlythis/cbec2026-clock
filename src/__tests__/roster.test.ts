import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  cellDate,
  cellText,
  cellTime,
  parseRosterWorkbook,
  queueNumberFor,
  resolveTableCode,
  slotKey,
  tableDayKey,
  validateRosterRows,
  type RosterRow,
  type RosterValidationContext,
} from '../roster';
import type { TableDayRow, TimeSlotRow } from '../types';

const WORKBOOK = path.resolve(__dirname, '..', '..', 'Final Matching Data.xlsx');

describe('table alias map', () => {
  it('maps every workbook label to an internal code', () => {
    assert.equal(resolveTableCode('THAILANDPOSTMART-1'), 'THPM');
    assert.equal(resolveTableCode('JD.com-1'), 'JD.com_1');
    assert.equal(resolveTableCode('TMALL-1'), 'TMALL');
    assert.equal(resolveTableCode('SHOPEE-2'), 'SHOPEE_2');
  });

  it('maps Alibaba and Profreight to the same physical table', () => {
    // Profreight is Alibaba's group with a different vendor, and takes exactly
    // the Alibaba positions on day 2. They never share a day, so no collision.
    assert.equal(resolveTableCode('Alibaba-1'), 'ALIBABA_1');
    assert.equal(resolveTableCode('Profreight-1'), 'ALIBABA_1');
    assert.equal(resolveTableCode('Alibaba-2'), 'ALIBABA_2');
    assert.equal(resolveTableCode('Profreight-2'), 'ALIBABA_2');
  });

  it('ignores surrounding whitespace and case', () => {
    assert.equal(resolveTableCode('  jd.com-2  '), 'JD.com_2');
  });

  it('returns null for anything unknown', () => {
    assert.equal(resolveTableCode('LAZADA-1'), null);
    assert.equal(resolveTableCode(''), null);
  });
});

describe('Excel cell readers', () => {
  it('reads a date without shifting it into the host timezone', () => {
    // ExcelJS returns a UTC-midnight Date. Reading it with local getters under
    // TZ=Asia/Bangkok would move an evening date onto the following day.
    assert.equal(cellDate(new Date('2026-08-17T00:00:00.000Z')), '2026-08-17');
    assert.equal(cellDate('2026-08-18 00:00:00'), '2026-08-18');
    assert.equal(cellDate(null), null);
  });

  it('reads a time without shifting it into the host timezone', () => {
    assert.equal(cellTime(new Date('1899-12-30T10:00:00.000Z')), '10:00');
    assert.equal(cellTime(new Date('1899-12-30T16:45:00.000Z')), '16:45');
  });

  it('reads an Excel serial fraction as a wall-clock time', () => {
    assert.equal(cellTime(0.41666666666666663), '10:00');
    assert.equal(cellTime(0.5), '12:00');
    assert.equal(cellTime(0.65625), '15:45');
  });

  it('reads plain string times', () => {
    assert.equal(cellTime('9:30'), '09:30');
    assert.equal(cellTime('13:15:00'), '13:15');
    assert.equal(cellTime('not a time'), null);
  });

  it('flattens rich text and formula cells', () => {
    assert.equal(cellText({ richText: [{ text: 'Siam ' }, { text: 'Foods' }] }), 'Siam Foods');
    assert.equal(cellText({ formula: 'A1', result: 'Bangkok Silk' } as never), 'Bangkok Silk');
    assert.equal(cellText('  padded  '), 'padded');
    assert.equal(cellText(null), '');
  });
});

describe('queue numbers', () => {
  it('derives a stable number from table position and original slot', () => {
    assert.equal(queueNumberFor(1, 0), 'A001');
    assert.equal(queueNumberFor(1, 22), 'A023');
    assert.equal(queueNumberFor(9, 0), 'I001');
    assert.equal(queueNumberFor(10, 33), 'J034');
  });
});

// --- validation ----------------------------------------------------------

function day(overrides: Partial<TableDayRow & { event_date: string }> = {}) {
  return {
    event_date: '2026-08-17',
    table_code: 'THPM',
    display_label: 'THAILANDPOSTMART-1',
    short_label: 'THPM',
    platform: 'THAILANDPOSTMART',
    grid_key: 'main' as const,
    duration_seconds: 900,
    display_order: 1,
    is_active: true,
    ...overrides,
  };
}

function slot(overrides: Partial<TimeSlotRow> = {}): TimeSlotRow {
  return {
    id: 1,
    event_date: '2026-08-17',
    grid_key: 'main',
    slot_index: 0,
    starts_at: '10:00:00',
    ends_at: '10:15:00',
    ...overrides,
  };
}

function context(days: (TableDayRow & { event_date: string })[], slots: TimeSlotRow[]): RosterValidationContext {
  return {
    tableDays: new Map(days.map((d) => [tableDayKey(d.event_date, d.table_code), d])),
    slots: new Map(slots.map((s) => [slotKey(s.event_date, s.grid_key, s.starts_at), s])),
  };
}

function row(overrides: Partial<RosterRow> = {}): RosterRow {
  return {
    eventDate: '2026-08-17',
    startTime: '10:00',
    endTime: '10:15',
    platform: 'THAILANDPOSTMART',
    tableCode: 'THPM',
    tableLabel: 'THAILANDPOSTMART-1',
    companyName: 'Siam Foods Co., Ltd.',
    contactNames: null,
    contactEmails: null,
    province: null,
    productCategory: null,
    priorityGroup: null,
    durationMinutes: 15,
    sourceLine: 2,
    ...overrides,
  };
}

describe('roster validation', () => {
  it('accepts a row that matches the day roster and the slot grid', () => {
    assert.deepEqual(validateRosterRows([row()], context([day()], [slot()])), []);
  });

  it('rejects a table that does not trade on that date', () => {
    // Alibaba-1 on 18 Aug: that position is Profreight's on day 2.
    const errors = validateRosterRows(
      [row({ eventDate: '2026-08-18', tableLabel: 'Alibaba-1', tableCode: 'ALIBABA_1' })],
      context([day()], [slot()]),
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /does not trade on 2026-08-18/);
  });

  it('rejects a booking on a table closed for the day', () => {
    const errors = validateRosterRows(
      [row({ tableCode: 'AMAZON_2', tableLabel: 'AMAZON-2' })],
      context([day({ table_code: 'AMAZON_2', display_label: 'AMAZON-2', is_active: false })], [slot()]),
    );
    assert.match(errors[0].message, /marked closed/);
  });

  it('rejects a duration that does not match the table', () => {
    const errors = validateRosterRows(
      [row({ durationMinutes: 10 })],
      context([day()], [slot()]),
    );
    assert.match(errors[0].message, /15-minute meetings/);
  });

  it('rejects a start time that is not a slot on that grid', () => {
    // 10:50 is a SHOPEE gap and never a main-grid slot.
    const errors = validateRosterRows(
      [row({ startTime: '10:50' })],
      context([day()], [slot()]),
    );
    assert.match(errors[0].message, /not a slot on the main grid/);
  });

  it('rejects two companies booked into the same cell', () => {
    const errors = validateRosterRows(
      [row(), row({ companyName: 'Other Co', sourceLine: 3 })],
      context([day()], [slot()]),
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Two companies are booked/);
  });

  it('allows the same time on two different tables', () => {
    const errors = validateRosterRows(
      [row(), row({ tableCode: 'TMALL', tableLabel: 'TMALL-1', sourceLine: 3 })],
      context([day(), day({ table_code: 'TMALL', display_label: 'TMALL-1', display_order: 6 })], [slot()]),
    );
    assert.deepEqual(errors, []);
  });
});

// --- the real workbook ---------------------------------------------------

describe('the approved workbook', () => {
  it('parses every row with no errors', async () => {
    const result = await parseRosterWorkbook(WORKBOOK);
    assert.deepEqual(result.errors.slice(0, 5), []);
    assert.equal(result.rows.length, 415);
    assert.equal(result.rows.length, result.totalDataRows);
  });

  it('has the expected per-day table lineup', async () => {
    const { rows } = await parseRosterWorkbook(WORKBOOK);
    const labels = (date: string) =>
      [...new Set(rows.filter((r) => r.eventDate === date).map((r) => r.tableLabel))].sort();

    assert.deepEqual(labels('2026-08-17'), [
      'AMAZON-1', 'AMAZON-2', 'Alibaba-1', 'Alibaba-2', 'JD.com-1', 'JD.com-2',
      'SHOPEE-1', 'SHOPEE-2', 'THAILANDPOSTMART-1', 'TMALL-1',
    ]);
    // Day 2 swaps Alibaba for Profreight and has no AMAZON-2 bookings at all.
    assert.deepEqual(labels('2026-08-18'), [
      'AMAZON-1', 'JD.com-1', 'JD.com-2', 'Profreight-1', 'Profreight-2',
      'SHOPEE-1', 'SHOPEE-2', 'THAILANDPOSTMART-1', 'TMALL-1',
    ]);
  });

  it('uses ten minutes for SHOPEE and fifteen everywhere else', async () => {
    const { rows } = await parseRosterWorkbook(WORKBOOK);
    for (const r of rows) {
      assert.equal(
        r.durationMinutes,
        r.tableCode.startsWith('SHOPEE') ? 10 : 15,
        `${r.tableLabel} ${r.startTime}`,
      );
    }
  });

  it('carries contact details for every appointment', async () => {
    const { rows } = await parseRosterWorkbook(WORKBOOK);
    assert.equal(rows.filter((r) => r.contactEmails).length, 415);
  });

  it('never books one company at two tables in the same slot', async () => {
    const { rows } = await parseRosterWorkbook(WORKBOOK);
    const seen = new Map<string, string>();
    for (const r of rows) {
      const key = `${r.eventDate}|${r.startTime}|${r.companyName}`;
      const previous = seen.get(key);
      assert.equal(previous, undefined, `${r.companyName} double-booked at ${r.startTime}`);
      seen.set(key, r.tableLabel);
    }
  });
});
