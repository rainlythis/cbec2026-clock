import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { loadConfig } from './config';
import { logger } from './logger';

// Keep DATE (1082) and TIME (1083) as plain strings. The default DATE parser
// builds a JS Date at *host* midnight, which silently shifts the event day on
// a UTC server; the event day is a calendar label, not an instant.
types.setTypeParser(1082, (value) => value);
types.setTypeParser(1083, (value) => value);

let pool: Pool | null = null;

/**
 * Lazily-created connection pool. `pg` reconnects broken connections on its
 * own; the error handler below keeps a dropped backend from crashing the
 * process (Railway restarts Postgres during maintenance).
 */
export function getPool(): Pool {
  if (pool) return pool;

  const config = loadConfig();
  const needsSsl =
    /\bsslmode=require\b/.test(config.databaseUrl) ||
    (config.isProduction && !/localhost|127\.0\.0\.1/.test(config.databaseUrl));

  pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });

  pool.on('error', (err) => {
    logger.error('Idle PostgreSQL client error (pool will reconnect)', err);
  });

  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Runs `fn` inside a transaction, rolling back on any thrown error. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error('Rollback failed', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Blocks until the database answers, retrying with linear backoff. */
export async function waitForDatabase(attempts = 12, delayMs = 2_000): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await query('SELECT 1');
      logger.info('Connected to PostgreSQL');
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      logger.warn('PostgreSQL not ready, retrying', { attempt, attempts });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}
