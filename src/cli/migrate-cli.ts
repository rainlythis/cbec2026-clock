import { closePool, waitForDatabase } from '../db';
import { logger } from '../logger';
import { runMigrations } from '../migrate';

async function main(): Promise<void> {
  await waitForDatabase(5, 1_000);
  const applied = await runMigrations();
  if (applied.length === 0) logger.info('Nothing to apply - schema already current');
  await closePool();
}

main().catch(async (error) => {
  logger.error('Migration failed', error);
  await closePool().catch(() => undefined);
  process.exit(1);
});
