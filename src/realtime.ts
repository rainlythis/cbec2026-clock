import type { Server as HttpServer } from 'node:http';
import { Server as IoServer } from 'socket.io';
import { loadConfig } from './config';
import { SESSION_COOKIE, verifySessionToken } from './auth';
import { logger } from './logger';
import { buildSnapshot, expireFinishedTimers } from './service';

/** Socket.IO room that only a signed-in operator can join. */
export const OPERATOR_ROOM = 'operators';

/** Minimal cookie header parser - no need to pull cookie-parser into the socket path. */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}

let io: IoServer | null = null;
let tickHandle: NodeJS.Timeout | null = null;
let heartbeatHandle: NodeJS.Timeout | null = null;
let pendingBroadcast: NodeJS.Timeout | null = null;
let lastBroadcastAt = 0;

/** How often the server checks for expired timers. */
const TICK_MS = 1_000;
/** Clock-sync + safety re-broadcast interval. */
const HEARTBEAT_MS = 5_000;
/** Full state is re-sent at least this often even with no changes. */
const FULL_RESYNC_MS = 15_000;

export function attachRealtime(server: HttpServer): IoServer {
  io = new IoServer(server, {
    // Long-poll fallback stays enabled for restrictive venue wifi.
    transports: ['websocket', 'polling'],
    pingInterval: 10_000,
    pingTimeout: 20_000,
    serveClient: true,
    cors: { origin: false },
  });

  io.on('connection', async (socket) => {
    // Grid deltas carry the operator's working roster, so they go to a room
    // that only a valid session cookie can join. Public viewers on /display and
    // /live never see them.
    const token = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
    if (verifySessionToken(token, loadConfig().sessionSecret)) {
      socket.join(OPERATOR_ROOM);
    }

    try {
      socket.emit('state', await buildSnapshot());
    } catch (error) {
      logger.error('Failed to send initial state', error);
    }

    // The only message a client may send: a clock-sync probe. There is no
    // control action reachable over the socket, so a public viewer has no
    // write path at all.
    socket.on('time:ping', (clientSent: unknown, ack?: (payload: unknown) => void) => {
      const payload = { clientSent, serverTime: Date.now() };
      if (typeof ack === 'function') ack(payload);
      else socket.emit('time:pong', payload);
    });
  });

  startLoops();
  return io;
}

function startLoops(): void {
  tickHandle = setInterval(async () => {
    try {
      const expired = await expireFinishedTimers();
      if (expired.length > 0) {
        logger.info('Timers reached zero', { tables: expired });
        await broadcastState();
      }
    } catch (error) {
      logger.error('Timer tick failed', error);
    }
  }, TICK_MS);

  heartbeatHandle = setInterval(async () => {
    if (!io) return;
    io.emit('sync', { serverTime: Date.now() });
    if (Date.now() - lastBroadcastAt >= FULL_RESYNC_MS) {
      try {
        await broadcastState();
      } catch (error) {
        logger.error('Heartbeat re-sync failed', error);
      }
    }
  }, HEARTBEAT_MS);
}

/**
 * Pushes the full snapshot to every screen. Coalesced on a short timer so a
 * burst of operator actions produces one broadcast, well inside the two-second
 * update budget.
 */
export async function broadcastState(): Promise<void> {
  if (!io) return;
  if (pendingBroadcast) return;

  pendingBroadcast = setTimeout(async () => {
    pendingBroadcast = null;
    try {
      const snapshot = await buildSnapshot();
      io?.emit('state', snapshot);
      lastBroadcastAt = Date.now();
    } catch (error) {
      logger.error('Broadcast failed', error);
    }
  }, 40);
}

/**
 * Pushes a grid change to signed-in operators only.
 *
 * Sent as a delta rather than the whole grid: a move touches two cells and a
 * full column compaction about thirty, so this stays a few KB even though the
 * full day grid is ~250 cells.
 */
export function broadcastGrid(payload: {
  date: string;
  gridRevision: number;
  cells: unknown[];
  removed?: number[];
}): void {
  io?.to(OPERATOR_ROOM).emit('grid:changed', payload);
}

export async function shutdownRealtime(): Promise<void> {
  if (tickHandle) clearInterval(tickHandle);
  if (heartbeatHandle) clearInterval(heartbeatHandle);
  if (pendingBroadcast) clearTimeout(pendingBroadcast);
  tickHandle = heartbeatHandle = pendingBroadcast = null;
  if (io) {
    await new Promise<void>((resolve) => io?.close(() => resolve()));
    io = null;
  }
}
