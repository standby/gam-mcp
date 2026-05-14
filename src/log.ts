// JSON-lines stderr logger. Hand-rolled (zero deps) so we can audit every
// byte that touches stderr — the spec is firm that credentials never get
// logged, and a generic redaction layer is the wrong tool for that
// guarantee. Instead, the contract is: callers don't pass sensitive fields,
// and tests/log-integration.test.ts pins a sentinel-token check end-to-end.

export type Level = 'error' | 'warn' | 'info' | 'debug';

export interface Logger {
  error(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
}

const LEVEL_RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const VALID_LEVELS = new Set<Level>(['error', 'warn', 'info', 'debug']);

export function levelFromEnv(env: NodeJS.ProcessEnv): Level {
  const raw = env.GAM_LOG_LEVEL;
  if (raw === undefined) return 'info';
  const lower = raw.toLowerCase();
  if (VALID_LEVELS.has(lower as Level)) return lower as Level;
  // Bad value: warn once on stderr (not via the logger itself, since the
  // logger isn't constructed yet) and fall back to info. Don't crash —
  // log config is operational, not load-bearing for functionality.
  process.stderr.write(
    `gam-mcp: GAM_LOG_LEVEL=${JSON.stringify(raw)} is not one of error|warn|info|debug; defaulting to info\n`,
  );
  return 'info';
}

export function createLogger(opts: {
  level?: Level;
  // Sink override for tests — receives one fully-formed line (with trailing
  // newline). Production uses the default which writes to stderr.
  sink?: (line: string) => void;
} = {}): Logger {
  const level = opts.level ?? 'info';
  const threshold = LEVEL_RANK[level];
  const sink = opts.sink ?? ((line: string) => process.stderr.write(line));

  const emit = (eventLevel: Level, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_RANK[eventLevel] > threshold) return;
    // Caller fields go first so a sloppy caller can't stomp ts/level/msg
    // and corrupt the log shape — the reserved keys must always win.
    const payload = {
      ...(fields ?? {}),
      ts: new Date().toISOString(),
      level: eventLevel,
      msg,
    };
    sink(JSON.stringify(payload) + '\n');
  };

  return {
    error: (msg, fields) => emit('error', msg, fields),
    warn:  (msg, fields) => emit('warn',  msg, fields),
    info:  (msg, fields) => emit('info',  msg, fields),
    debug: (msg, fields) => emit('debug', msg, fields),
  };
}

// Noop logger for tests/handlers that don't care about observability.
// Cheaper than constructing a real logger pointed at a discard sink.
export function noopLogger(): Logger {
  const noop = (): void => {};
  return { error: noop, warn: noop, info: noop, debug: noop };
}
