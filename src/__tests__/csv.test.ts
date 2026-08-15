import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseCsv, parseSchedule } from '../csv';

const TABLES = [
  'THPM', 'JD.com_1', 'JD.com_2', 'TMALL', 'AMAZON_1', 'AMAZON_2',
  'ALIBABA_1', 'ALIBABA_2', 'SHOPEE_1', 'SHOPEE_2',
];

const HEADER =
  'event_date,scheduled_start,scheduled_end,platform,table_code,queue_number,company_name,appointment_status,arrival_status';

const options = { knownTableCodes: TABLES };

describe('CSV reader', () => {
  it('keeps commas inside quoted company names', () => {
    const rows = parseCsv('a,b\n1,"Siam Foods Co., Ltd."\n');
    assert.deepEqual(rows[1], ['1', 'Siam Foods Co., Ltd.']);
  });

  it('handles escaped quotes and CRLF line endings', () => {
    const rows = parseCsv('a\r\n"He said ""yes"""\r\n');
    assert.deepEqual(rows[1], ['He said "yes"']);
  });
});

describe('schedule validation', () => {
  it('accepts a well-formed file', () => {
    const csv = `${HEADER}
2026-08-17,10:00,10:15,THPM,THPM,A001,"Siam Foods Co., Ltd.",scheduled,not_arrived
2026-08-17,10:00,10:10,SHOPEE,SHOPEE_1,S001,Bangkok Silk,arrived,arrived`;
    const result = parseSchedule(csv, options);
    assert.deepEqual(result.errors, []);
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].scheduledStart, '10:00:00');
    assert.equal(result.rows[0].companyName, 'Siam Foods Co., Ltd.');
  });

  it('reports a missing column instead of importing a partial file', () => {
    const result = parseSchedule('event_date,platform\n2026-08-17,THPM', options);
    assert.equal(result.rows.length, 0);
    assert.match(result.errors[0].message, /Missing required column/);
  });

  it('rejects an unknown table code, with the line number', () => {
    const csv = `${HEADER}\n2026-08-17,10:00,10:15,LAZADA,LAZADA_1,A001,Test Co,scheduled,not_arrived`;
    const result = parseSchedule(csv, options);
    assert.equal(result.rows.length, 0);
    assert.equal(result.errors[0].line, 2);
    assert.equal(result.errors[0].column, 'table_code');
  });

  it('rejects bad dates, bad times and reversed time ranges', () => {
    const csv = `${HEADER}
2026-13-45,10:00,10:15,THPM,THPM,A001,Test Co,scheduled,not_arrived
2026-08-17,25:00,10:15,THPM,THPM,A002,Test Co,scheduled,not_arrived
2026-08-17,10:30,10:15,THPM,THPM,A003,Test Co,scheduled,not_arrived`;
    const result = parseSchedule(csv, options);
    assert.equal(result.rows.length, 0);
    assert.deepEqual(
      result.errors.map((e) => e.column),
      ['event_date', 'scheduled_start', 'scheduled_end'],
    );
  });

  it('rejects a duplicate queue number on the same table and date', () => {
    const csv = `${HEADER}
2026-08-17,10:00,10:15,THPM,THPM,A001,First Co,scheduled,not_arrived
2026-08-17,10:15,10:30,THPM,THPM,A001,Second Co,scheduled,not_arrived`;
    const result = parseSchedule(csv, options);
    assert.equal(result.rows.length, 1);
    assert.match(result.errors[0].message, /Duplicate queue number/);
  });

  it('rejects an unknown status rather than guessing', () => {
    const csv = `${HEADER}\n2026-08-17,10:00,10:15,THPM,THPM,A001,Test Co,maybe,not_arrived`;
    assert.equal(parseSchedule(csv, options).errors[0].column, 'appointment_status');
  });

  it('normalises common arrival spellings and defaults blanks', () => {
    const csv = `${HEADER}
2026-08-17,10:00,10:15,THPM,THPM,A001,Test Co,,yes
2026-08-17,10:15,10:30,THPM,THPM,A002,Test Co,,`;
    const result = parseSchedule(csv, options);
    assert.deepEqual(result.errors, []);
    assert.equal(result.rows[0].arrivalStatus, 'arrived');
    assert.equal(result.rows[1].arrivalStatus, 'not_arrived');
    assert.equal(result.rows[1].appointmentStatus, 'scheduled');
  });

  it('enforces the allowed event dates when supplied', () => {
    const csv = `${HEADER}\n2026-09-01,10:00,10:15,THPM,THPM,A001,Test Co,scheduled,not_arrived`;
    const result = parseSchedule(csv, {
      ...options,
      allowedDates: ['2026-08-17', '2026-08-18'],
    });
    assert.match(result.errors[0].message, /outside the event/);
  });
});

describe('bundled data files', () => {
  const dataDir = path.resolve(__dirname, '..', '..', 'data');

  it('the CSV template is valid', () => {
    const csv = fs.readFileSync(path.join(dataDir, 'schedule_template.csv'), 'utf8');
    assert.deepEqual(parseSchedule(csv, options).errors, []);
  });

  it('the sample schedule is valid and covers all ten tables on both days', () => {
    const csv = fs.readFileSync(path.join(dataDir, 'sample_schedule.csv'), 'utf8');
    const result = parseSchedule(csv, {
      ...options,
      allowedDates: ['2026-08-17', '2026-08-18'],
    });
    assert.deepEqual(result.errors.slice(0, 5), []);
    assert.equal(result.rows.length, result.totalDataRows);

    for (const table of TABLES) {
      for (const date of ['2026-08-17', '2026-08-18']) {
        const rows = result.rows.filter((r) => r.tableCode === table && r.eventDate === date);
        assert.ok(rows.length > 0, `${table} has no appointments on ${date}`);
      }
    }
  });

  it('sample SHOPEE slots are ten minutes and the rest are fifteen', () => {
    const csv = fs.readFileSync(path.join(dataDir, 'sample_schedule.csv'), 'utf8');
    const { rows } = parseSchedule(csv, options);
    const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));

    for (const row of rows) {
      const length = minutes(row.scheduledEnd) - minutes(row.scheduledStart);
      assert.equal(length, row.tableCode.startsWith('SHOPEE') ? 10 : 15, `${row.tableCode} ${row.queueNumber}`);
    }
  });
});
