import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

// The environment must be in place before config.ts is first required, so the
// application modules are pulled in with require() below rather than import.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/does_not_connect';
process.env.CONTROL_PASSWORD = 'correct-horse-battery-staple';
process.env.SESSION_SECRET = 'test-session-secret-value';
process.env.COOKIE_SECURE = 'false';
process.env.PUBLIC_BASE_URL = 'http://localhost:8080';

/* eslint-disable @typescript-eslint/no-var-requires */
const express = require('express') as typeof import('express');
const cookieParser = require('cookie-parser') as typeof import('cookie-parser');
const auth = require('../auth') as typeof import('../auth');
const { loadConfig } = require('../config') as typeof import('../config');
const { authRouter } = require('../routes/control') as typeof import('../routes/control');

const SECRET = 'test-session-secret-value';

describe('session tokens', () => {
  it('accepts a token it just issued', () => {
    const token = auth.issueSessionToken(12, SECRET);
    assert.notEqual(auth.verifySessionToken(token, SECRET), null);
  });

  it('rejects a token signed with a different secret', () => {
    const token = auth.issueSessionToken(12, 'some-other-secret');
    assert.equal(auth.verifySessionToken(token, SECRET), null);
  });

  it('rejects a tampered payload', () => {
    const token = auth.issueSessionToken(12, SECRET);
    const forged = Buffer.from(JSON.stringify({ sub: 'operator', iat: 0, exp: 9_999_999_999 }))
      .toString('base64url');
    assert.equal(auth.verifySessionToken(`${forged}.${token.split('.')[1]}`, SECRET), null);
  });

  it('rejects a tampered signature', () => {
    const [body] = auth.issueSessionToken(12, SECRET).split('.');
    assert.equal(auth.verifySessionToken(`${body}.not-a-real-signature`, SECRET), null);
  });

  it('rejects malformed and missing tokens', () => {
    assert.equal(auth.verifySessionToken(undefined, SECRET), null);
    assert.equal(auth.verifySessionToken('', SECRET), null);
    assert.equal(auth.verifySessionToken('no-dot-here', SECRET), null);
    assert.equal(auth.verifySessionToken('a.b.c', SECRET), null);
  });

  it('rejects an expired token', () => {
    const now = Date.now();
    const token = auth.issueSessionToken(1, SECRET, now);
    assert.notEqual(auth.verifySessionToken(token, SECRET, now + 59 * 60_000), null);
    assert.equal(auth.verifySessionToken(token, SECRET, now + 61 * 60_000), null);
  });
});

describe('passcode check', () => {
  it('accepts only the exact passcode', () => {
    assert.equal(auth.checkPassword('correct-horse-battery-staple', 'correct-horse-battery-staple'), true);
    assert.equal(auth.checkPassword('Correct-horse-battery-staple', 'correct-horse-battery-staple'), false);
    assert.equal(auth.checkPassword('', 'correct-horse-battery-staple'), false);
    assert.equal(auth.checkPassword(undefined, 'correct-horse-battery-staple'), false);
    assert.equal(auth.checkPassword(123, 'correct-horse-battery-staple'), false);
    assert.equal(auth.checkPassword({ toString: () => 'correct-horse-battery-staple' }, 'correct-horse-battery-staple'), false);
  });
});

describe('cookie configuration', () => {
  it('is HttpOnly, SameSite=strict and honours COOKIE_SECURE', () => {
    const options = auth.sessionCookieOptions();
    assert.equal(options.httpOnly, true);
    assert.equal(options.sameSite, 'strict');
    assert.equal(options.path, '/');
    assert.equal(loadConfig().cookieSecure, false);
  });
});

// --- HTTP-level authorization -------------------------------------------

describe('control endpoints are closed to the public', () => {
  let server: http.Server;
  let base = '';

  before(async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', authRouter());

    // Stands in for the real control router: same guard, no database.
    const guarded = express.Router();
    guarded.use(auth.requireOperator);
    guarded.post('/tables/THPM/toggle', (_req, res) => res.json({ ok: true, applied: true }));
    guarded.post('/global/reset', (_req, res) => res.json({ ok: true, applied: true }));
    app.use('/api/control', guarded);

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    auth.resetLoginThrottle();
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;

  const post = (path: string, body?: unknown, cookie?: string) =>
    fetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });

  it('refuses a control action with no session', async () => {
    const response = await post('/api/control/tables/THPM/toggle');
    assert.equal(response.status, 401);
    assert.equal((await json(response)).error, 'unauthorized');
  });

  it('refuses a control action with a forged cookie', async () => {
    const response = await post(
      '/api/control/global/reset',
      { confirm: true },
      `${auth.SESSION_COOKIE}=eyJzdWIiOiJvcGVyYXRvciJ9.forged`,
    );
    assert.equal(response.status, 401);
  });

  it('rejects the wrong passcode', async () => {
    const response = await post('/api/auth/login', { password: 'not-the-passcode' });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('set-cookie'), null);
    auth.resetLoginThrottle();
  });

  it('rejects a missing passcode', async () => {
    assert.equal((await post('/api/auth/login', {})).status, 401);
    auth.resetLoginThrottle();
  });

  it('issues an HttpOnly session cookie for the correct passcode and then allows control', async () => {
    const login = await post('/api/auth/login', { password: 'correct-horse-battery-staple' });
    assert.equal(login.status, 200);

    const setCookie = login.headers.get('set-cookie');
    assert.ok(setCookie, 'expected a Set-Cookie header');
    assert.match(setCookie as string, /HttpOnly/i);
    assert.match(setCookie as string, /SameSite=Strict/i);
    // The passcode itself must never appear in the cookie or any URL.
    assert.ok(!(setCookie as string).includes('correct-horse-battery-staple'));

    const cookie = (setCookie as string).split(';')[0];
    const allowed = await post('/api/control/tables/THPM/toggle', {}, cookie);
    assert.equal(allowed.status, 200);
    assert.equal((await json(allowed)).applied, true);

    const status = await fetch(base + '/api/auth/status', { headers: { Cookie: cookie } });
    assert.equal((await json(status)).authenticated, true);

    // ...and signing out closes the door again.
    const logout = await post('/api/auth/logout', {}, cookie);
    assert.equal(logout.status, 200);
    const cleared = logout.headers.get('set-cookie') ?? '';
    assert.match(cleared, new RegExp(`${auth.SESSION_COOKIE}=;`));
  });

  it('reports an anonymous visitor as unauthenticated', async () => {
    const status = await fetch(base + '/api/auth/status');
    assert.equal((await json(status)).authenticated, false);
  });

  it('throttles repeated wrong passcodes', async () => {
    auth.resetLoginThrottle();
    let sawThrottle = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await post('/api/auth/login', { password: 'wrong' });
      if (response.status === 429) {
        sawThrottle = true;
        break;
      }
    }
    assert.equal(sawThrottle, true, 'expected a 429 after repeated failures');
    auth.resetLoginThrottle();
  });
});
