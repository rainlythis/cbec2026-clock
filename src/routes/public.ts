import { Router } from 'express';
import QRCode from 'qrcode';
import { loadConfig } from '../config';
import { buildSnapshot } from '../service';

/**
 * Read-only endpoints for /display and /live.
 * Nothing here mutates state and nothing here exposes contact details.
 */
export function publicRouter(): Router {
  const router = Router();

  // Clock-sync probe used by every client to measure its offset from the
  // server, so a phone with a wrong local clock still shows the right MM:SS.
  router.get('/time', (_req, res) => {
    res.json({ serverTime: Date.now() });
  });

  // Polling fallback when the websocket cannot connect.
  router.get('/state', async (_req, res, next) => {
    try {
      res.json(await buildSnapshot());
    } catch (error) {
      next(error);
    }
  });

  /**
   * QR code for the room screen.
   *
   * The target is PUBLIC_BASE_URL when it is set, and otherwise the origin this
   * request actually arrived on (`trust proxy` is enabled, so behind Railway's
   * edge that resolves to the real https host). That fallback means the QR is
   * correct on a fresh deploy with no configuration, instead of silently
   * encoding localhost.
   *
   * The resolved target is echoed in the `X-QR-Target` header so it can be
   * checked with curl without decoding the image.
   */
  router.get('/qr.svg', async (req, res, next) => {
    try {
      const config = loadConfig();
      const path = typeof req.query.path === 'string' && req.query.path.startsWith('/')
        ? req.query.path
        : '/live';
      const origin = config.publicBaseUrl ?? `${req.protocol}://${req.get('host')}`;
      const target = `${origin}${path}`;

      const svg = await QRCode.toString(target, {
        type: 'svg',
        margin: 0,
        errorCorrectionLevel: 'M',
        color: { dark: '#111111', light: '#FFFFFF' },
      });
      res
        .type('image/svg+xml')
        .set('Cache-Control', 'public, max-age=300')
        .set('X-QR-Target', target)
        .send(svg);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
