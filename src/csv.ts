/**
 * Minimal RFC 4180 CSV reader plus schedule validation.
 * Kept dependency-free so the import rules are testable in isolation.
 */

export const CSV_COLUMNS = [
  'event_date',
  'scheduled_start',
  'scheduled_end',
  'platform',
  'table_code',
  'queue_number',
  'company_name',
  'appointment_status',
  'arrival_status',
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

export const APPOINTMENT_STATUSES = [
  'scheduled',
  'arrived',
  'called',
  'in_meeting',
  'completed',
  'skipped',
  'no_show',
] as const;

export const ARRIVAL_STATUSES = ['not_arrived', 'arrived'] as const;

export interface ScheduleRow {
  eventDate: string;
  scheduledStart: string;
  scheduledEnd: string;
  platform: string;
  tableCode: string;
  queueNumber: string;
  companyName: string;
  appointmentStatus: string;
  arrivalStatus: string;
}

export interface RowError {
  line: number;
  column: string;
  message: string;
  value?: string;
}

export interface ParseResult {
  rows: ScheduleRow[];
  errors: RowError[];
  totalDataRows: number;
}

/** Splits CSV text into records, honouring quotes, escaped quotes and CRLF. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let started = false;

  const input = text.replace(/^﻿/, '');

  const endField = () => {
    record.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
    started = false;
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      started = true;
    } else if (char === ',') {
      endField();
      started = true;
    } else if (char === '\r') {
      // handled by the \n branch
    } else if (char === '\n') {
      endRecord();
    } else {
      field += char;
      started = true;
    }
  }

  if (started || field !== '' || record.length > 0) endRecord();

  return records.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;

function normaliseTime(value: string): string | null {
  const match = TIME_RE.exec(value.trim());
  if (!match) return null;
  return `${match[1]}:${match[2]}:${match[4] ?? '00'}`;
}

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export interface ValidateOptions {
  /** Known table codes; rows referring to anything else are rejected. */
  knownTableCodes: string[];
  /** Allowed event dates. Empty array disables the check. */
  allowedDates?: string[];
}

/**
 * Parses and validates an uploaded schedule.
 * Every bad row is reported with its 1-based file line so the operator can fix
 * the spreadsheet; nothing is written unless the caller decides to proceed.
 */
export function parseSchedule(text: string, options: ValidateOptions): ParseResult {
  const records = parseCsv(text);
  const errors: RowError[] = [];
  const rows: ScheduleRow[] = [];

  if (records.length === 0) {
    return { rows, errors: [{ line: 0, column: 'file', message: 'The file is empty.' }], totalDataRows: 0 };
  }

  const header = records[0].map((h) => h.trim().toLowerCase());
  const missing = CSV_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return {
      rows,
      errors: [
        {
          line: 1,
          column: 'header',
          message: `Missing required column(s): ${missing.join(', ')}. Expected header: ${CSV_COLUMNS.join(',')}`,
        },
      ],
      totalDataRows: 0,
    };
  }

  const index = Object.fromEntries(CSV_COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<
    CsvColumn,
    number
  >;
  const tableCodes = new Set(options.knownTableCodes);
  const allowedDates = new Set(options.allowedDates ?? []);
  const seen = new Map<string, number>();

  for (let r = 1; r < records.length; r += 1) {
    const line = r + 1;
    const raw = records[r];
    const get = (column: CsvColumn) => (raw[index[column]] ?? '').trim();
    const rowErrorsBefore = errors.length;

    const eventDate = get('event_date');
    if (!isRealDate(eventDate)) {
      errors.push({ line, column: 'event_date', value: eventDate, message: 'Expected a real date as YYYY-MM-DD.' });
    } else if (allowedDates.size > 0 && !allowedDates.has(eventDate)) {
      errors.push({
        line,
        column: 'event_date',
        value: eventDate,
        message: `Date is outside the event. Allowed: ${[...allowedDates].join(', ')}.`,
      });
    }

    const start = normaliseTime(get('scheduled_start'));
    if (!start) {
      errors.push({ line, column: 'scheduled_start', value: get('scheduled_start'), message: 'Expected HH:MM (24h).' });
    }
    const end = normaliseTime(get('scheduled_end'));
    if (!end) {
      errors.push({ line, column: 'scheduled_end', value: get('scheduled_end'), message: 'Expected HH:MM (24h).' });
    }
    if (start && end && end <= start) {
      errors.push({ line, column: 'scheduled_end', value: get('scheduled_end'), message: 'End time must be after the start time.' });
    }

    const tableCode = get('table_code');
    if (!tableCodes.has(tableCode)) {
      errors.push({
        line,
        column: 'table_code',
        value: tableCode,
        message: `Unknown table. Allowed: ${options.knownTableCodes.join(', ')}.`,
      });
    }

    const platform = get('platform');
    if (!platform) {
      errors.push({ line, column: 'platform', message: 'Platform is required.' });
    }

    const queueNumber = get('queue_number');
    if (!queueNumber) {
      errors.push({ line, column: 'queue_number', message: 'Queue number is required.' });
    }

    const companyName = get('company_name');
    if (!companyName) {
      errors.push({ line, column: 'company_name', message: 'Company name is required.' });
    }

    const appointmentStatus = (get('appointment_status') || 'scheduled').toLowerCase().replace(/[\s-]+/g, '_');
    if (!(APPOINTMENT_STATUSES as readonly string[]).includes(appointmentStatus)) {
      errors.push({
        line,
        column: 'appointment_status',
        value: get('appointment_status'),
        message: `Allowed values: ${APPOINTMENT_STATUSES.join(', ')}.`,
      });
    }

    let arrivalStatus = (get('arrival_status') || 'not_arrived').toLowerCase().replace(/[\s-]+/g, '_');
    if (arrivalStatus === 'yes' || arrivalStatus === 'true' || arrivalStatus === '1') arrivalStatus = 'arrived';
    if (arrivalStatus === 'no' || arrivalStatus === 'false' || arrivalStatus === '0') arrivalStatus = 'not_arrived';
    if (!(ARRIVAL_STATUSES as readonly string[]).includes(arrivalStatus)) {
      errors.push({
        line,
        column: 'arrival_status',
        value: get('arrival_status'),
        message: `Allowed values: ${ARRIVAL_STATUSES.join(', ')}.`,
      });
    }

    const key = `${eventDate}|${tableCode}|${queueNumber}`;
    const previous = seen.get(key);
    if (previous) {
      errors.push({
        line,
        column: 'queue_number',
        value: queueNumber,
        message: `Duplicate queue number for this table and date (first seen on line ${previous}).`,
      });
    } else {
      seen.set(key, line);
    }

    if (errors.length === rowErrorsBefore) {
      rows.push({
        eventDate,
        scheduledStart: start as string,
        scheduledEnd: end as string,
        platform,
        tableCode,
        queueNumber,
        companyName,
        appointmentStatus,
        arrivalStatus,
      });
    }
  }

  return { rows, errors, totalDataRows: records.length - 1 };
}
