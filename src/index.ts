import http from 'node:http';
import { createApp } from './app';
import { loadConfig } from './config';
import { closePool, waitForDatabase } from './db';
import { logger } from './logger';
import { runMigrations } from './migrate';
import { attachRealtime, shutdownRealtime } from './realtime';

async function main(): Promise<void> {
  const config = loadConfig();
  process.env.TZ = config.timezone;

  await waitForDatabase();
  await runMigrations();

  const app = createApp();
  const server = http.createServer(app);
  attachRealtime(server);

  server.listen(config.port, () => {
    logger.info('TOPTHAI Day Business Matching Live is running', {
      port: config.port,
      timezone: config.timezone,
      baseUrl: config.publicBaseUrl,
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
