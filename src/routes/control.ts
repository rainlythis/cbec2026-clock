import { Router } from 'express';
import { loadConfig } from '../config';
import {
  SESSION_COOKIE,
  checkPassword,
  clearLoginFailures,
  isOperator,
  issueSessionToken,
  loginThrottle,
  recordLoginFailure,
  requireOperator,
  sessionCookieOptions,
} from '../auth';
import { logger } from '../logger';
import { parseSchedule } from '../csv';
import { broadcastGrid, broadcastState } from '../realtime';
import {
  OperationError,
  adjustTimer,
  appointmentsForDate,
  buildGrid,
  clearCell,
  exportSchedule,
  moveCell,
  noShowAndPush,
  renameCell,
  revealContact,
  swapCells,
  type GridMutationResult,
  completeAndNext,
  getSettings,
  getTables,
  globalReset,
  globalToggle,
  importSchedule,
  previousAppointment,
  recallAppointment,
  recentOperations,
  resetTimer,
  selectCurrent,
  setActiveDate,
  setArrival,
  setSoundEnabled,
  setTablePresence,
  skipAndNext,
  toggleTimer,
} from '../service';

/** Wraps an async mutation: run it, broadcast, answer `{ok:true}`. */
function mutation(handler: (req: import('express').Request) => Promise<unknown>) {
  return async (
    req: import('express').Request,
    res: import('express').Response,
    next: import('express').NextFunction,
  ) => {
    try {
      const result = await handler(req);
      await broadcastState();
      res.json({ ok: true, ...(result && typeof result === 'object' ? result : {}) });
    } catch (error) {
      if (error instanceof OperationError) {
        res.status(error.code === 'not_found' ? 404 : 409).json({
          ok: false,
          error: error.code,
          message: error.message,
        });
        return;
      }
      next(error);
    }
  };
}

function intParam(value: unknown, field: string): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) throw new OperationError(`Invalid ${field}.`, 'bad_request');
  return parsed;
}

export function authRouter(): Router {
  const router = Router();
  const config = loadConfig();

  router.get('/status', (req, res) => {
    res.json({ authenticated: isOperator(req) });
  });

  router.post('/login', loginThrottle, (req, res) => {
    const password = (req.body as { password?: unknown } | undefined)?.password;
    if (!checkPassword(password, config.controlPassword)) {
      recordLoginFailure(req);
      logger.warn('Failed operator login', { ip: req.ip });
      res.status(401).json({ ok: false, error: 'invalid_password', message: 'Incorrect passcode.' });
      return;
    }
    clearLoginFailures(req);
    const token = issueSessionToken(config.sessionTtlHours, config.sessionSecret);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
    logger.info('Operator signed in', { ip: req.ip });
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
    res.json({ ok: true });
  });

  return router;
}

/**
 * Every mutating endpoint in the system lives here, behind `requireOperator`.
 * There is no control action on the public API and none over Socket.IO.
 */
export function controlRouter(): Router {
  const router = Router();
  router.use(requireOperator);

  // --- per-table timer controls ---
  router.post('/tables/:code/toggle', mutation((req) => toggleTimer(req.params.code)));
  router.post('/tables/:code/reset', mutation((req) => resetTimer(req.params.code)));
  router.post('/tables/:code/complete-next', mutation((req) => completeAndNext(req.params.code)));
  // Back: undoes the last Complete & Next / Skip & Next at this table.
  router.post('/tables/:code/back', mutation((req) => previousAppointment(req.params.code)));
  router.post(
    '/tables/:code/skip-next',
    mutation((req) => skipAndNext(req.params.code, (req.body as { noShow?: boolean })?.noShow === true)),
  );

  // --- "More" menu ---
  router.post(
    '/tables/:code/adjust',
    mutation(async (req) => {
      const delta = intParam((req.body as { deltaSeconds?: unknown })?.deltaSeconds, 'deltaSeconds');
      if (Math.abs(delta) > 15 * 60) throw new OperationError('Adjustment is limited to 15 minutes.');
      return adjustTimer(req.params.code, delta);
    }),
  );
  router.post(
    '/tables/:code/presence',
    mutation(async (req) => {
      const status = (req.body as { status?: string })?.status;
      if (status !== 'break' && status !== 'closed' && status !== 'ready') {
        throw new OperationError('Status must be break, closed or ready.', 'bad_request');
      }
      return setTablePresence(req.params.code, status);
    }),
  );

  // --- queue workflow ---
  router.post(
    '/tables/:code/select',
    mutation((req) =>
      selectCurrent(req.params.code, intParam((req.body as { appointmentId?: unknown })?.appointmentId, 'appointmentId')),
    ),
  );
  router.post(
    '/appointments/:id/arrival',
    mutation((req) =>
      setArrival(intParam(req.params.id, 'id'), (req.body as { arrived?: boolean })?.arrived !== false),
    ),
  );
  router.post(
    '/appointments/:id/recall',
    mutation((req) => recallAppointment(intParam(req.params.id, 'id'))),
  );

  // --- global controls ---
  router.post('/global/toggle', mutation(() => globalToggle()));
  router.post(
    '/global/reset',
    mutation(async (req) => {
      // Belt and braces: the UI confirms, and the API insists on the flag too.
      if ((req.body as { confirm?: boolean })?.confirm !== true) {
        throw new OperationError('Reset All must be confirmed.', 'bad_request');
      }
      return globalReset();
    }),
  );

  // --- settings ---
  router.post(
    '/settings/sound',
    mutation((req) => setSoundEnabled((req.body as { enabled?: boolean })?.enabled === true)),
  );
  router.post(
    '/settings/active-date',
    mutation((req) => setActiveDate(String((req.body as { date?: unknown })?.date ?? ''))),
  );

  // --- schedule ---
  router.get('/appointments', async (req, res, next) => {
    try {
      const settings = await getSettings();
      const date = typeof req.query.date === 'string' ? req.query.date : settings.active_event_date;
      res.json({ ok: true, date, appointments: await appointmentsForDate(date) });
    } catch (error) {
      next(error);
    }
  });

  /**
   * The operator's editable grid for one day.
   *
   * Takes its date from the query string rather than the active event day, so
   * day 2 can be prepared while day 1 is still running in the room.
   */
  router.get('/grid', async (req, res, next) => {
    try {
      const settings = await getSettings();
      const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
        ? req.query.date
        : settings.active_event_date;
      res.json({ ok: true, activeDate: settings.active_event_date, ...(await buildGrid(date)) });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Grid mutations.
   *
   * Same guard as every other control action; on success the changed cells are
   * pushed as a delta to the operators room only, and the public snapshot is
   * re-broadcast so /display and /live pick up any queue change.
   */
  function gridMutation(handler: (req: import('express').Request) => Promise<GridMutationResult>) {
    return async (
      req: import('express').Request,
      res: import('express').Response,
      next: import('express').NextFunction,
    ) => {
      try {
        const result = await handler(req);
        const grid = await buildGrid(result.date);
        const changed = new Set(result.changed);
        broadcastGrid({
          date: result.date,
          gridRevision: result.gridRevision,
          cells: [...grid.cells, ...grid.parked].filter((c) => changed.has(c.appointmentId)),
          removed: [],
        });
        await broadcastState();
        res.json({ ok: true, ...result });
      } catch (error) {
        if (error instanceof OperationError) {
          const status = error.code === 'not_found' ? 404 : error.code === 'stale' ? 409 : 409;
          res.status(status).json({ ok: false, error: error.code, message: error.message });
          return;
        }
        next(error);
      }
    };
  }

  const version = (value: unknown): number | undefined => {
    if (value === undefined || value === null) return undefined;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  router.post(
    '/grid/cell/no-show-push',
    gridMutation((req) => {
      const body = req.body as { appointmentId?: unknown; expectedVersion?: unknown; push?: unknown };
      return noShowAndPush(
        intParam(body?.appointmentId, 'appointmentId'),
        version(body?.expectedVersion),
        body?.push === true,
      );
    }),
  );

  router.post(
    '/grid/cell/move',
    gridMutation((req) => {
      const body = req.body as {
        appointmentId?: unknown;
        tableCode?: unknown;
        slotId?: unknown;
        expectedVersion?: unknown;
      };
      const slotId = body?.slotId === null ? null : intParam(body?.slotId, 'slotId');
      return moveCell(
        intParam(body?.appointmentId, 'appointmentId'),
        String(body?.tableCode ?? ''),
        slotId,
        version(body?.expectedVersion),
      );
    }),
  );

  router.post(
    '/grid/cell/swap',
    gridMutation((req) => {
      const body = req.body as {
        firstId?: unknown;
        secondId?: unknown;
        firstVersion?: unknown;
        secondVersion?: unknown;
      };
      return swapCells(intParam(body?.firstId, 'firstId'), intParam(body?.secondId, 'secondId'), {
        first: version(body?.firstVersion),
        second: version(body?.secondVersion),
      });
    }),
  );

  router.post(
    '/grid/cell/clear',
    gridMutation((req) => {
      const body = req.body as { appointmentId?: unknown; expectedVersion?: unknown };
      return clearCell(intParam(body?.appointmentId, 'appointmentId'), version(body?.expectedVersion));
    }),
  );

  router.post(
    '/grid/cell/rename',
    gridMutation((req) => {
      const body = req.body as { appointmentId?: unknown; companyName?: unknown };
      return renameCell(intParam(body?.appointmentId, 'appointmentId'), String(body?.companyName ?? ''));
    }),
  );

  /**
   * Contact details for one appointment - operator eyes only, fetched on the
   * click that reveals them and recorded in the operation log.
   */
  router.get('/appointments/:id/contact', async (req, res, next) => {
    try {
      res.json({ ok: true, ...(await revealContact(intParam(req.params.id, 'id'))) });
    } catch (error) {
      if (error instanceof OperationError) {
        res.status(404).json({ ok: false, error: error.code, message: error.message });
        return;
      }
      next(error);
    }
  });

  /**
   * Exports the live grid in the workbook's Master Schedule shape.
   *
   * Contact columns are deliberately NOT included: they never change during the
   * event, the operator still has the original workbook, and leaving them out
   * keeps the guarantee that contact data is selected in exactly one place.
   */
  router.get('/grid/export.csv', async (req, res, next) => {
    try {
      const settings = await getSettings();
      const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
        ? req.query.date
        : settings.active_event_date;
      const rows = await exportSchedule(date);

      const quote = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
      const header = [
        'event_date', 'scheduled_start', 'scheduled_end', 'platform', 'table_label',
        'queue_number', 'company_name', 'appointment_status', 'arrival_status', 'moved',
      ];
      const body = rows.map((r) =>
        [
          r.eventDate, r.scheduledStart, r.scheduledEnd, r.platform, r.tableLabel,
          r.queueNumber ?? '', r.companyName, r.appointmentStatus, r.arrivalStatus,
          r.moved ? 'moved' : '',
        ].map((v) => quote(String(v))).join(','),
      );

      // The BOM keeps Excel from mangling Thai company names on open.
      res
        .type('text/csv; charset=utf-8')
        .set('Content-Disposition', `attachment; filename="topthai-schedule-${date}.csv"`)
        .send('﻿' + [header.join(','), ...body].join('\r\n') + '\r\n');
    } catch (error) {
      next(error);
    }
  });

  router.get('/operations', async (_req, res, next) => {
    try {
      res.json({ ok: true, operations: await recentOperations(40) });
    } catch (error) {
      next(error);
    }
  });

  /**
   * CSV import. `dryRun` validates and reports without writing, which is what
   * the control page calls first; the operator then confirms the real import.
   */
  router.post('/schedule/import', async (req, res, next) => {
    try {
      const body = req.body as { csv?: unknown; dryRun?: boolean } | undefined;
      const csv = typeof body?.csv === 'string' ? body.csv : '';
      if (!csv.trim()) {
        res.status(400).json({ ok: false, error: 'empty_file', message: 'No CSV content received.' });
        return;
      }

      const tables = await getTables();
      const result = parseSchedule(csv, {
        knownTableCodes: tables.map((t) => t.table_code),
        allowedDates: [],
      });

      if (result.errors.length > 0) {
        res.status(422).json({
          ok: false,
          error: 'invalid_csv',
          message: `${result.errors.length} problem(s) found. Nothing was imported.`,
          errors: result.errors.slice(0, 100),
          validRows: result.rows.length,
          totalRows: result.totalDataRows,
        });
        return;
      }

      if (body?.dryRun) {
        res.json({
          ok: true,
          dryRun: true,
          validRows: result.rows.length,
          totalRows: result.totalDataRows,
          dates: [...new Set(result.rows.map((r) => r.eventDate))].sort(),
        });
        return;
      }

      const imported = await importSchedule(result.rows);
      await broadcastState();
      res.json({ ok: true, ...imported });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
