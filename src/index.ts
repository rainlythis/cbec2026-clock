import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app';
import { loadConfig } from './config';
import { parseSchedule } from './csv';
import { closePool, query, waitForDatabase } from './db';
import { logger } from './logger';
import { runMigrations } from './migrate';
import { attachRealtime, shutdownRealtime } from './realtime';
import { parseRosterWorkbook, validateRosterRows } from './roster';
import { getTables, importRoster, importSchedule, loadRosterContext } from './service';

async function autoSeedIfEmpty(): Promise<void> {
  try {
    const existing = await query<{ count: string }>('SELECT count(*)::text AS count FROM appointments');
    if (Number(existing[0].count) > 0) return;

    const xlsxFile = path.resolve(__dirname, '..', 'Final Matching Data.xlsx');
    if (fs.existsSync(xlsxFile)) {
      const parsed = await parseRosterWorkbook(xlsxFile);
      if (parsed.errors.length === 0) {
        const context = await loadRosterContext();
        const problems = validateRosterRows(parsed.rows, context);
        if (problems.length === 0) {
          const result = await importRoster(parsed.rows);
          logger.info('Auto-imported roster workbook on initial startup', { ...result });
          return;
        }
      }
    }

    const csvFile = path.resolve(__dirname, '..', 'data', 'sample_schedule.csv');
    if (fs.existsSync(csvFile)) {
      const csv = await fs.promises.readFile(csvFile, 'utf8');
      const tables = await getTables();
      const result = parseSchedule(csv, { knownTableCodes: tables.map((t) => t.table_code) });
      if (result.errors.length === 0) {
        const imported = await importSchedule(result.rows);
        logger.info('Auto-seeded sample schedule on initial startup', { ...imported });
      }
    }
  } catch (error) {
    logger.error('Auto-seed check failed', error);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  process.env.TZ = config.timezone;

  await waitForDatabase();
  await runMigrations();
  await autoSeedIfEmpty();

  const app = createApp();
  const server = http.createServer(app);
  attachRealtime(server);

  server.listen(config.port, () => {
    logger.info('TOPTHAI Day Business Matching Live is running', {
      port: config.port,
      timezone: config.timezone,
      baseUrl: config.publicBaseUrl ?? '(PUBLIC_BASE_URL not set - the QR code will use each request\'s own origin)',
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });

    // Stop accepting new work, then let in-flight requests drain. Timer state
    // lives in PostgreSQL, so nothing is lost by exiting here.
    const forced = setTimeout(() => {
      logger.warn('Forcing exit after shutdown timeout');
      process.exit(1);
    }, 10_000);
    forced.unref();

    try {
      await shutdownRealtime();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closePool();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason);
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', error);
    void shutdown('uncaughtException');
  });
}

main().catch((error) => {
  logger.error('Fatal startup error', error);
  process.exit(1);
});
