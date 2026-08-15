import dotenv from 'dotenv';

dotenv.config();

/** Everything user-facing is rendered in this zone, regardless of host TZ. */
export const EVENT_TIMEZONE = process.env.TZ || 'Asia/Bangkok';

/** The two event days, in Asia/Bangkok calendar dates. */
export const EVENT_DATES = ['2026-08-17', '2026-08-18'] as const;

/** Operating sessions used for the "Break / Session" banner on the display. */
export const EVENT_SESSIONS = [
  { label: 'Session 1', start: '10:00', end: '12:00' },
  { label: 'Session 2', start: '13:00', end: '15:30' },
  { label: 'Session 3', start: '15:45', end: '17:00' },
] as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example for the full list.`,
    );
  }
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
  controlPassword: string;
  sessionSecret: string;
  /**
   * Explicit public origin, or null when PUBLIC_BASE_URL is not set.
   *
   * Null on purpose rather than a localhost default: the QR code on the room
   * screen is built from this, and a QR that silently encodes localhost is the
   * kind of fault you discover when a room full of people is scanning it. When
   * this is null the QR falls back to the origin the request actually arrived
   * on, which is correct on Railway without any configuration.
   */
  publicBaseUrl: string | null;
  timezone: string;
  isProduction: boolean;
  cookieSecure: boolean;
  sessionTtlHours: number;
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;

  const isProduction = process.env.NODE_ENV === 'production';
  const cookieSecureRaw = process.env.COOKIE_SECURE;

  cached = {
    port: optionalInt('PORT', 8080),
    databaseUrl: required('DATABASE_URL'),
    controlPassword: required('CONTROL_PASSWORD'),
    sessionSecret: required('SESSION_SECRET'),
    publicBaseUrl: process.env.PUBLIC_BASE_URL
      ? process.env.PUBLIC_BASE_URL.trim().replace(/\/+$/, '')
      : null,
    timezone: EVENT_TIMEZONE,
    isProduction,
    cookieSecure: cookieSecureRaw ? cookieSecureRaw !== 'false' : isProduction,
    sessionTtlHours: optionalInt('SESSION_TTL_HOURS', 12),
  };

  return cached;
}
