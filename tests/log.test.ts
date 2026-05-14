import { describe, it, expect } from 'vitest';
import { createLogger, levelFromEnv, noopLogger, type Level } from '../src/log.js';

function captureSink(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line: string) => { lines.push(line); } };
}

describe('logger', () => {
  it('filters events below the configured level', () => {
    const { lines, sink } = captureSink();
    const logger = createLogger({ level: 'warn', sink });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    // warn level emits warn + error only.
    const msgs = lines.map((l) => JSON.parse(l).msg);
    expect(msgs).toEqual(['w', 'e']);
  });

  it('emits at all levels when set to debug', () => {
    const { lines, sink } = captureSink();
    const logger = createLogger({ level: 'debug', sink });
    logger.debug('d'); logger.info('i'); logger.warn('w'); logger.error('e');
    expect(lines).toHaveLength(4);
  });

  it('writes valid JSON-lines with ts/level/msg + caller fields', () => {
    const { lines, sink } = captureSink();
    const logger = createLogger({ level: 'info', sink });
    logger.info('event.name', { tool: 'kv_breakdown', duration_ms: 42 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\n$/);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('event.name');
    expect(parsed.tool).toBe('kv_breakdown');
    expect(parsed.duration_ms).toBe(42);
    expect(typeof parsed.ts).toBe('string');
    expect(new Date(parsed.ts).toString()).not.toBe('Invalid Date');
  });

  it('caller fields cannot override the reserved ts/level/msg keys', () => {
    // The spread order in log.ts is { ts, level, msg, ...fields } — so a
    // caller passing `level: 'sneaky'` would silently overwrite the real
    // level. Pin the inverse: reserved keys must win.
    const { lines, sink } = captureSink();
    const logger = createLogger({ level: 'info', sink });
    logger.info('m', { level: 'sneaky', msg: 'sneaky', ts: 'sneaky' } as Record<string, unknown>);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('m');
    expect(parsed.ts).not.toBe('sneaky');
  });

  it('defaults to info level when no level is given', () => {
    const { lines, sink } = captureSink();
    const logger = createLogger({ sink });
    logger.debug('d');
    logger.info('i');
    expect(lines.map((l) => JSON.parse(l).msg)).toEqual(['i']);
  });
});

describe('levelFromEnv', () => {
  it('returns info when GAM_LOG_LEVEL is unset', () => {
    expect(levelFromEnv({})).toBe('info');
  });

  it.each<[string, Level]>([
    ['error', 'error'],
    ['warn', 'warn'],
    ['info', 'info'],
    ['debug', 'debug'],
    ['DEBUG', 'debug'],
    ['Info', 'info'],
  ])('accepts %s (any case)', (raw, expected) => {
    expect(levelFromEnv({ GAM_LOG_LEVEL: raw })).toBe(expected);
  });

  it('falls back to info on invalid value (does not crash)', () => {
    // Suppress the warning write so it doesn't pollute test output.
    const orig = process.stderr.write.bind(process.stderr);
    let warned = '';
    process.stderr.write = ((s: string | Uint8Array) => {
      warned += typeof s === 'string' ? s : Buffer.from(s).toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(levelFromEnv({ GAM_LOG_LEVEL: 'verbose' })).toBe('info');
      expect(warned).toContain('GAM_LOG_LEVEL');
      expect(warned).toContain('verbose');
    } finally {
      process.stderr.write = orig;
    }
  });
});

describe('noopLogger', () => {
  it('accepts all level calls without side effects', () => {
    const logger = noopLogger();
    // Just ensure no throw — there's nothing observable to assert.
    logger.error('a'); logger.warn('b'); logger.info('c'); logger.debug('d');
    logger.info('with fields', { tool: 'x', n: 1 });
  });
});
