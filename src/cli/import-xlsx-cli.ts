import path from 'node:path';
import { closePool, query, waitForDatabase } from '../db';
import { logger } from '../logger';
import { runMigrations } from '../migrate';
import { parseRosterWorkbook, validateRosterRows } from '../roster';
import { importRoster, loadRosterContext } from '../service';

/**
 * Loads the approved matching workbook into the live roster.
 *
 *   npm run import:xlsx -- "Final Matching Data.xlsx" [--force]
 *
 * Refuses to run if appointments already exist for the dates in the file, since
 * after the first import the web grid is the source of truth and re-importing
 * would discard live event changes. --force overrides.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const file = args.find((a) => !a.startsWith('--'))
    ?? path.resolve(process.cwd(), 'Final Matching Data.xlsx');

  await waitForDatabase(5, 1_000);
  await runMigrations();

  const parsed = await parseRosterWorkbook(file);
  if (parsed.errors.length > 0) {
    logger.error('Workbook rejected - nothing imported', undefined, {
      errors: parsed.errors.length,
      first: parsed.errors.slice(0, 15),
    });
    process.exitCode = 1;
    await closePool();
    return;
  }

  const context = await loadRosterContext();
  const problems = validateRosterRows(parsed.rows, context);
  if (problems.length > 0) {
    logger.error('Roster failed validation - nothing imported', undefined, {
      errors: problems.length,
      first: problems.slice(0, 15),
    });
    process.exitCode = 1;
    await closePool();
    return;
  }

  const dates = [...new Set(parsed.rows.map((r) => r.eventDate))].sort();
  const existing = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM appointments WHERE event_date = ANY($1::date[])`,
    [dates],
  );
  if (Number(existing[0].count) > 0 && !force) {
    logger.warn('Appointments already exist for these dates - refusing to overwrite', {
      dates,
      existing: Number(existing[0].count),
      hint: 'Re-run with --force if you really mean to replace the live roster.',
    });
    process.exitCode = 1;
    await closePool();
    return;
  }

  const result = await importRoster(parsed.rows);
  logger.info('Import complete', { file, ...result });
  await closePool();
}

main().catch(async (error) => {
  logger.error('Import failed', error);
  await closePool().catch(() => undefined);
  process.exit(1);
});
