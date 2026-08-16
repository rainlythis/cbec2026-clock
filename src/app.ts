import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { loadConfig } from './config';
import { query } from './db';
import { logger } from './logger';
import { authRouter, controlRouter } from './routes/control';
import { publicRouter } from './routes/public';

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

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
