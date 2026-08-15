import crypto from 'node:crypto';
import type { CookieOptions, NextFunction, Request, Response } from 'express';
import { loadConfig } from './config';
import { logger } from './logger';

export const SESSION_COOKIE = 'topthai_operator';

interface SessionPayload {
  sub: 'operator';
  iat: number;
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

/** Constant-time compare that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function issueSessionToken(ttlHours: number, secret: string, nowMs = Date.now()): string {
  const payload: SessionPayload = {
    sub: 'operator',
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + ttlHours * 3600,
  };
  const body = base64url(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

/** Returns the payload only for a token with an intact signature and a future exp. */
export function verifySessionToken(
  token: string | undefined,
  secret: string,
  nowMs = Date.now(),
): SessionPayload | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!safeEqual(signature, sign(body, secret))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (payload.sub !== 'operator') return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Timing-safe passcode check against CONTROL_PASSWORD. */
export function checkPassword(candidate: unknown, expected: string): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function sessionCookieOptions(): CookieOptions {
  const config = loadConfig();
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    path: '/',
    maxAge: config.sessionTtlHours * 3600 * 1000,
  };
}

export function isOperator(req: Request): boolean {
  const config = loadConfig();
  const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  return verifySessionToken(token, config.sessionSecret) !== null;
}

/**
 * Gate for every mutating endpoint. Public visitors on /display and /live never
 * hit this, and no control action is reachable over Socket.IO at all.
 */
export function requireOperator(req: Request, res: Response, next: NextFunction): void {
  if (isOperator(req)) {
    next();
    return;
  }
  res.status(401).json({ ok: false, error: 'unauthorized', message: 'Operator sign-in required.' });
}

// --- brute-force throttle -------------------------------------------------
// One operator, one passcode: a small in-memory counter is enough and costs
// nothing. Deliberately not persisted - a restart clearing it is acceptable.

const attempts = new Map<string, { count: number; firstAt: number; blockedUntil: number }>();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const BLOCK_MS = 5 * 60 * 1000;

export function loginThrottle(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const entry = attempts.get(key);

  if (entry && entry.blockedUntil > now) {
    res.status(429).json({
      ok: false,
      error: 'too_many_attempts',
      message: 'Too many attempts. Try again in a few minutes.',
      retryAfterSeconds: Math.ceil((entry.blockedUntil - now) / 1000),
    });
    return;
  }
  next();
}

export function recordLoginFailure(req: Request): void {
  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || now - entry.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: now, blockedUntil: 0 });
    return;
  }
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.blockedUntil = now + BLOCK_MS;
    entry.count = 0;
    entry.firstAt = now;
    logger.warn('Operator login temporarily blocked', { ip: key });
  }
}

export function clearLoginFailures(req: Request): void {
  attempts.delete(req.ip ?? 'unknown');
}

/** Test seam: drops all throttle state. */
export function resetLoginThrottle(): void {
  attempts.clear();
}
