import fs from 'node:fs/promises';
import path from 'node:path';
import { getPool } from './db';
import { logger } from './logger';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

/**
 * Forward-only SQL migrations applied in filename order and recorded in
 * `schema_migrations`. Runs automatically on boot so a Railway deploy is a
 * single step.
 */
export async function runMigrations(): Promise<string[]> {
  const pool = getPool();
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    // Serialises concurrent boots (e.g. a rolling redeploy) onto one migrator.
    await client.query('SELECT pg_advisory_lock($1)', [908_231_774]);

    try {
      const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
      const done = new Set(
        (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
          (r) => r.name,
        ),
      );

      for (const file of files) {
        if (done.has(file)) continue;
        const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
        logger.info('Applying migration', { file });
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
          await client.query('COMMIT');
          applied.push(file);
        } catch (error) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [908_231_774]);
    }

    logger.info('Migrations up to date', { applied: applied.length });
    return applied;
  } finally {
    client.release();
  }
}
