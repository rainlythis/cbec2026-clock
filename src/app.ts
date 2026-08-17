import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { loadConfig } from './config';
import { query } from './db';
import { logger } from './logger';
import { authRouter, controlRouter } from './routes/control';
import { publicRouter } from './routes/public';

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

/**
 * Fingerprint of the frontend, computed once at boot.
 *
 * Sent with every state snapshot so a page can notice that the server is
 * serving newer JavaScript than the page is running, and reload itself. That
 * situation is otherwise invisible and total: the browser renders new HTML,
 * runs old code, and buttons silently do nothing. It matters most for the room
 * display, which nobody can reach mid-event.
 */
function computeAssetVersion(): string {
  const hash = crypto.createHash('sha256');
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|css|html)$/.test(entry.name)) {
        hash.update(entry.name).update(fs.readFileSync(full));
      }
    }
  };
  try {
    walk(PUBLIC_DIR);
    return hash.digest('hex').slice(0, 12);
  } catch (error) {
    logger.warn('Could not fingerprint the frontend; auto-reload on deploy is disabled', {
      error: (error as Error).message,
    });
    return 'unknown';
  }
}

export const ASSET_VERSION = computeAssetVersion();

export function createApp(): express.Express {
  const config = loadConfig();
  const app = express();

  // Railway terminates TLS at its edge; trusting the proxy gives us the real
  // client IP for the login throttle and correct secure-cookie behaviour.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  app.get('/health', async (_req, res) => {
    try {
      await query('SELECT 1');
      res.json({ status: 'ok', time: new Date().toISOString(), timezone: config.timezone });
    } catch (error) {
      logger.error('Health check failed', error);
      res.status(503).json({ status: 'degraded', error: 'database_unavailable' });
    }
  });

  app.use('/api', publicRouter());
  app.use('/api/auth', authRouter());
  app.use('/api/control', controlRouter());

  /**
   * Assets always revalidate.
   *
   * `no-cache` does not mean "do not store" - it means "ask before reusing", so
   * an unchanged file still costs only a 304. That matters more than the saved
   * bytes here: these files are a handful of KB, and a stale copy is invisible
   * but total. Caching the JS for an hour once left an operator mid-event with
   * new HTML calling into old JavaScript, with no symptom except buttons that
   * would not respond. Never cache the client of an app whose correctness
   * depends on it matching the server.
   */
  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      etag: true,
      lastModified: true,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    }),
  );

  const page = (file: string) => (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, file));
  };

  app.get('/', (_req, res) => res.redirect('/display'));
  app.get('/display', page('display.html'));
  app.get('/live', page('live.html'));
  app.get('/control', page('control.html'));
  app.get('/schedule', page('schedule.html'));
  // The bare clock board: a standalone countdown screen and its own control
  // page, sharing nothing with the matching event but the timer maths. Express
  // routing is case-insensitive, so /bare_clock reaches the same page.
  app.get('/Bare_Clock', page('bare-clock.html'));
  app.get('/Bare_Clock_Control', page('bare-clock-control.html'));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.status(404).sendFile(path.join(PUBLIC_DIR, 'not-found.html'));
  });

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled request error', error, { path: req.path, method: req.method });
    if (res.headersSent) return;
    res.status(500).json({
      ok: false,
      error: 'internal_error',
      message: 'Something went wrong. The action was not applied.',
    });
  });

  return app;
}
