type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta ?? {}),
  };
  const serialised = JSON.stringify(line);
  if (level === 'error') process.stderr.write(serialised + '\n');
  else process.stdout.write(serialised + '\n');
}

/** Structured single-line JSON logging - readable in Railway's log viewer. */
export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => emit('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => emit('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit('warn', message, meta),
  error: (message: string, error?: unknown, meta?: Record<string, unknown>) => {
    const detail =
      error instanceof Error
        ? { error: error.message, stack: error.stack }
        : error !== undefined
          ? { error: String(error) }
          : {};
    emit('error', message, { ...detail, ...(meta ?? {}) });
  },
};
