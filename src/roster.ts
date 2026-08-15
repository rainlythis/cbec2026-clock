import ExcelJS from 'exceljs';
import { EVENT_DATES } from './config';
import type { TableDayRow, TimeSlotRow } from './types';

/**
 * Reader and validator for the approved matching workbook.
 *
 * Only the `Master Schedule` sheet is read: the four matrix sheets are an exact
 * pivot of it (verified cell-for-cell) and it is the only sheet carrying the
 * contact columns.
 */

export const MASTER_SHEET = 'Master Schedule';

/**
 * Workbook table label -> internal table code.
 *
 * Positions 7 and 8 are one pair of physical tables that changes vendor between
 * the two days: Alibaba on 17 Aug, Profreight on 18 Aug. Both labels therefore
 * map to the same code, and they never collide because they never share a day.
 */
export const TABLE_ALIASES: Record<string, string> = {
  'THAILANDPOSTMART-1': 'THPM',
  'THAILANDPOSTMART': 'THPM',
  'THPM': 'THPM',
  'JD.com-1': 'JD.com_1',
  'JD.com-2': 'JD.com_2',
  'AMAZON-1': 'AMAZON_1',
  'AMAZON-2': 'AMAZON_2',
  'TMALL-1': 'TMALL',
  'TMALL': 'TMALL',
  'Alibaba-1': 'ALIBABA_1',
  'Alibaba-2': 'ALIBABA_2',
  'Profreight-1': 'ALIBABA_1',
  'Profreight-2': 'ALIBABA_2',
  'SHOPEE-1': 'SHOPEE_1',
  'SHOPEE-2': 'SHOPEE_2',
};

export function resolveTableCode(label: string): string | null {
  const trimmed = label.trim();
  if (TABLE_ALIASES[trimmed]) return TABLE_ALIASES[trimmed];
  const ci = Object.keys(TABLE_ALIASES).find((k) => k.toLowerCase() === trimmed.toLowerCase());
  return ci ? TABLE_ALIASES[ci] : null;
}

export interface RosterRow {
  eventDate: string;
  startTime: string;
  endTime: string;
  platform: string;
  tableCode: string;
  tableLabel: string;
  companyName: string;
  contactNames: string | null;
  contactEmails: string | null;
  province: string | null;
  productCategory: string | null;
  priorityGroup: string | null;
  durationMinutes: number;
  sourceLine: number;
}

export interface RosterError {
  line: number;
  column: string;
  value?: string;
  message: string;
}

export interface RosterParseResult {
  rows: RosterRow[];
  errors: RosterError[];
  totalDataRows: number;
}

/**
 * Excel stores a date and a time as two different instants and ExcelJS hands
 * both back as JS Dates. The UTC getters are the correct readers: the local
 * ones would shift a 10:00 cell by the host offset (to 17:00 under
 * TZ=Asia/Bangkok).
 */
export function cellDate(value: unknown): string | null {
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    return match ? match[1] : null;
  }
  return null;
}

export function cellTime(value: unknown): string | null {
  if (value instanceof Date) {
    const h = String(value.getUTCHours()).padStart(2, '0');
    const m = String(value.getUTCMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }
  if (typeof value === 'number') {
    // Excel serial time: a fraction of a day. Rounded to the minute because
    // 10:00 is often stored as 0.41666666666666663.
    const totalMinutes = Math.round(value * 24 * 60) % (24 * 60);
    const h = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
    const m = String(totalMinutes % 60).padStart(2, '0');
    return `${h}:${m}`;
  }
  if (typeof value === 'string') {
    const match = /^([01]?\d|2[0-3]):([0-5]\d)/.exec(value.trim());
    return match ? `${match[1].padStart(2, '0')}:${match[2]}` : null;
  }
  return null;
}

/** Flattens the shapes ExcelJS returns for a text cell (string, rich text, formula). */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  const obj = value as { richText?: { text: string }[]; text?: string; result?: unknown };
  if (Array.isArray(obj.richText)) return obj.richText.map((part) => part.text).join('').trim();
  if (typeof obj.text === 'string') return obj.text.trim();
  if (obj.result !== undefined) return cellText(obj.result);
  return '';
}

const COLUMNS = {
  date: 1,
  day: 2,
  start: 3,
  end: 4,
  platform: 5,
  table: 6,
  company: 7,
  contactNames: 8,
  contactEmails: 9,
  province: 10,
  productCategory: 11,
  duration: 12,
  priorityGroup: 13,
} as const;

export interface RosterValidationContext {
  /** Per-day roster, keyed `${event_date}|${table_code}`. */
  tableDays: Map<string, TableDayRow>;
  /** Slot lookup, keyed `${event_date}|${grid_key}|${start_time}`. */
  slots: Map<string, TimeSlotRow>;
}

export function slotKey(eventDate: string, gridKey: string, startTime: string): string {
  return `${eventDate}|${gridKey}|${startTime.slice(0, 5)}`;
}

export function tableDayKey(eventDate: string, tableCode: string): string {
  return `${eventDate}|${tableCode}`;
}

/**
 * Validates every row before anything is written. A row that fails is reported
 * with its spreadsheet line so the operator can fix the source; a file with any
 * failure imports nothing.
 */
export function validateRosterRows(
  rows: RosterRow[],
  context: RosterValidationContext,
): RosterError[] {
  const errors: RosterError[] = [];
  const seenCell = new Map<string, number>();

  for (const row of rows) {
    const day = context.tableDays.get(tableDayKey(row.eventDate, row.tableCode));

    if (!day) {
      errors.push({
        line: row.sourceLine,
        column: 'Table',
        value: row.tableLabel,
        message: `"${row.tableLabel}" does not trade on ${row.eventDate}.`,
      });
      continue;
    }
    if (!day.is_active) {
      errors.push({
        line: row.sourceLine,
        column: 'Table',
        value: row.tableLabel,
        message: `"${row.tableLabel}" is marked closed on ${row.eventDate}.`,
      });
      continue;
    }

    const expectedMinutes = Math.round(day.duration_seconds / 60);
    if (row.durationMinutes !== expectedMinutes) {
      errors.push({
        line: row.sourceLine,
        column: 'Duration (min)',
        value: String(row.durationMinutes),
        message: `${row.tableLabel} runs ${expectedMinutes}-minute meetings.`,
      });
      continue;
    }

    const slot = context.slots.get(slotKey(row.eventDate, day.grid_key, row.startTime));
    if (!slot) {
      errors.push({
        line: row.sourceLine,
        column: 'Start Time',
        value: row.startTime,
        message: `${row.startTime} is not a slot on the ${day.grid_key} grid for ${row.eventDate}.`,
      });
      continue;
    }

    const cell = `${row.eventDate}|${row.tableCode}|${slot.id}`;
    const previous = seenCell.get(cell);
    if (previous) {
      errors.push({
        line: row.sourceLine,
        column: 'Table',
        value: row.tableLabel,
        message: `Two companies are booked at ${row.tableLabel} ${row.startTime} (see line ${previous}).`,
      });
    } else {
      seenCell.set(cell, row.sourceLine);
    }
  }

  return errors;
}

/** Reads the Master Schedule sheet into typed rows, without touching the database. */
export async function parseRosterWorkbook(
  source: string | Buffer,
): Promise<RosterParseResult> {
  const workbook = new ExcelJS.Workbook();
  if (typeof source === 'string') await workbook.xlsx.readFile(source);
  else await workbook.xlsx.load(source as unknown as ArrayBuffer);

  const sheet = workbook.getWorksheet(MASTER_SHEET);
  if (!sheet) {
    return {
      rows: [],
      errors: [
        {
          line: 0,
          column: 'workbook',
          message: `The workbook has no "${MASTER_SHEET}" sheet. Sheets found: ${workbook.worksheets
            .map((w) => w.name)
            .join(', ')}.`,
        },
      ],
      totalDataRows: 0,
    };
  }

  const rows: RosterRow[] = [];
  const errors: RosterError[] = [];
  let dataRows = 0;

  for (let lineNumber = 2; lineNumber <= sheet.rowCount; lineNumber += 1) {
    const line = sheet.getRow(lineNumber);
    const rawDate = line.getCell(COLUMNS.date).value;
    const company = cellText(line.getCell(COLUMNS.company).value);
    const tableLabel = cellText(line.getCell(COLUMNS.table).value);

    // Skip genuinely blank trailing rows rather than reporting them as errors.
    if (!rawDate && !company && !tableLabel) continue;
    dataRows += 1;

    const before = errors.length;
    const eventDate = cellDate(rawDate);
    const startTime = cellTime(line.getCell(COLUMNS.start).value);
    const endTime = cellTime(line.getCell(COLUMNS.end).value);
    const tableCode = tableLabel ? resolveTableCode(tableLabel) : null;
    const durationRaw = cellText(line.getCell(COLUMNS.duration).value);
    const durationMinutes = Number.parseInt(durationRaw, 10);

    if (!eventDate) {
      errors.push({ line: lineNumber, column: 'Date', value: String(rawDate ?? ''), message: 'Expected a date.' });
    } else if (!EVENT_DATES.includes(eventDate as (typeof EVENT_DATES)[number])) {
      errors.push({
        line: lineNumber,
        column: 'Date',
        value: eventDate,
        message: `Outside the event. Allowed: ${EVENT_DATES.join(', ')}.`,
      });
    }
    if (!startTime) {
      errors.push({ line: lineNumber, column: 'Start Time', message: 'Expected a time as HH:MM.' });
    }
    if (!endTime) {
      errors.push({ line: lineNumber, column: 'End Time', message: 'Expected a time as HH:MM.' });
    }
    if (!tableLabel) {
      errors.push({ line: lineNumber, column: 'Table', message: 'Table is required.' });
    } else if (!tableCode) {
      errors.push({
        line: lineNumber,
        column: 'Table',
        value: tableLabel,
        message: `Unknown table. Known labels: ${Object.keys(TABLE_ALIASES).join(', ')}.`,
      });
    }
    if (!company) {
      errors.push({ line: lineNumber, column: 'Company Name', message: 'Company name is required.' });
    }
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      errors.push({
        line: lineNumber,
        column: 'Duration (min)',
        value: durationRaw,
        message: 'Expected a positive number of minutes.',
      });
    }

    if (errors.length !== before) continue;

    const optional = (column: number) => {
      const text = cellText(line.getCell(column).value);
      return text === '' ? null : text;
    };

    rows.push({
      eventDate: eventDate as string,
      startTime: startTime as string,
      endTime: endTime as string,
      platform: cellText(line.getCell(COLUMNS.platform).value),
      tableCode: tableCode as string,
      tableLabel,
      companyName: company,
      contactNames: optional(COLUMNS.contactNames),
      contactEmails: optional(COLUMNS.contactEmails),
      province: optional(COLUMNS.province),
      productCategory: optional(COLUMNS.productCategory),
      priorityGroup: optional(COLUMNS.priorityGroup),
      durationMinutes,
      sourceLine: lineNumber,
    });
  }

  return { rows, errors, totalDataRows: dataRows };
}

/**
 * Stable, human-readable queue numbers.
 *
 * The approved roster carries none, but entrepreneurs need something to look up
 * on /live. They are derived from the table's position and the appointment's
 * ORIGINAL slot, so pushing a queue up never renumbers anybody.
 */
export function queueNumberFor(displayOrder: number, slotIndex: number): string {
  const letter = String.fromCharCode('A'.charCodeAt(0) + Math.max(0, displayOrder - 1));
  return `${letter}${String(slotIndex + 1).padStart(3, '0')}`;
}
