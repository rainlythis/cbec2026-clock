import fs from 'node:fs/promises';
import path from 'node:path';
import { parseSchedule } from '../csv';
import { closePool, waitForDatabase } from '../db';
import { logger } from '../logger';
import { runMigrations } from '../migrate';
import { getTables, importSchedule } from '../service';

/**
 * Loads a CSV schedule from the command line (defaults to the bundled sample
 * covering all ten tables) using exactly the same validation as the operator's
 * import screen.
 */
async function main(): Promise<void> {
  const file = process.argv[2] ?? path.resolve(__dirname, '..', '..', 'data', 'sample_schedule.csv');

  await waitForDatabase(5, 1_000);
  await runMigrations();

  const csv = await fs.readFile(file, 'utf8');
  const tables = await getTables();
  const result = parseSchedule(csv, { knownTableCodes: tables.map((t) => t.table_code) });

  if (result.errors.length > 0) {
    logger.error('Sample schedule is invalid - nothing imported', undefined, {
      errors: result.errors.slice(0, 20),
    });
    process.exitCode = 1;
    await closePool();
    return;
  }

  const imported = await importSchedule(result.rows);
  logger.info('Seed complete', { file, ...imported });
  await closePool();
}

main().catch(async (error) => {
  logger.error('Seed failed', error);
  await closePool().catch(() => undefined);
  process.exit(1);
});
