import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeGam, takeViolations, findViolations } from './fake-gam.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const sources = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f.replaceAll('\\', '/'), text: readFileSync(join(SRC, f), 'utf8') }));

describe('structure', () => {
  it('H4: only report-exec polls report operations (usage.ts only wraps the client)', () => {
    const callers = sources.filter((s) => /\.pollOperation\(/.test(s.text)).map((s) => s.file).sort();
    expect(callers).toEqual(['report-exec.ts', 'usage.ts']);
  });

  it('nothing writes report rows to disk any more', () => {
    expect(existsSync(join(SRC, 'output.ts'))).toBe(false);
    const hits = sources.filter((s) => /downloadReport|fromCsvGzFile|file_path|readCsvGz/.test(s.text)).map((s) => s.file);
    expect(hits).toEqual([]);
  });

  it('H7: the string literal POST appears in src/ only in gam-client-rest.ts, inside defineReport, runReport and the retry-policy check', () => {
    // Keying on the object key name `method` would miss a shorthand
    // `{ method }` write. Instead find every quoted POST literal in src/ and
    // require each one to sit inside one of the three places the client is
    // allowed to send one: defineReport, runReport, and the retry-policy
    // check in withRetries (`const post = method === 'POST'`).
    const withLiteral = sources.filter((s) => /(['"])POST\1/.test(s.text)).map((s) => s.file);
    expect(withLiteral).toEqual(['gam-client-rest.ts']);

    const text = sources.find((s) => s.file === 'gam-client-rest.ts')!.text;
    const occurrences = [...text.matchAll(/(['"])POST\1/g)];
    expect(occurrences.length).toBe(3);

    const bounds = {
      withRetries: [text.indexOf('function withRetries'), text.indexOf('function sleepWithJitter')],
      defineReport: [text.indexOf('async defineReport'), text.indexOf('async runReport')],
      runReport: [text.indexOf('async runReport'), text.indexOf('async fetchRows')],
    } as const;
    expect(Object.values(bounds).every(([start, end]) => start >= 0 && end > start)).toBe(true);

    const regionOf = (index: number): string => {
      const hit = Object.entries(bounds).find(([, [start, end]]) => index > start && index < end);
      return hit ? hit[0] : 'unknown';
    };
    const regions = occurrences.map((m) => regionOf(m.index)).sort();
    expect(regions).toEqual(['defineReport', 'runReport', 'withRetries']);
  });

  // Any other HTTP write method, written as a string literal in any quotes.
  const OTHER_WRITE = /(['"`])(PUT|PATCH|DELETE)\1/;

  it('H7: no string literal PUT, PATCH or DELETE appears in src/', () => {
    for (const q of [`'`, `"`, '`']) {
      for (const m of ['PUT', 'PATCH', 'DELETE']) expect(OTHER_WRITE.test(`method: ${q}${m}${q}`)).toBe(true);
    }
    expect(OTHER_WRITE.test("method: 'GET'")).toBe(false);
    expect(sources.filter((s) => OTHER_WRITE.test(s.text)).map((s) => s.file)).toEqual([]);
  });

  it('H7: a fake GAM records every write other than create and run', async () => {
    const gam = createFakeGam();
    const url = (p: string) => `https://admanager.googleapis.com/v1/${p}`;
    await gam.fetch(url('networks/1234/reports/1:patch'), { method: 'POST', body: '{}' });
    await gam.fetch(url('networks/1234/reports/1'), { method: 'DELETE' });
    await gam.fetch(url('networks/1234/reports'), {
      method: 'POST',
      body: JSON.stringify({ reportDefinition: { timeZoneSource: 'PUBLISHER', currencyCode: 'USD' } }),
    });
    await gam.fetch(url('networks/1234/reports/1:run'), { method: 'POST', body: '{}' });
    expect(takeViolations()).toEqual(['POST networks/1234/reports/1:patch', 'DELETE networks/1234/reports/1']);
    expect(takeViolations()).toEqual([]);
  });

  it('H7: a fake GAM reads the method and URL of a Request passed without init', async () => {
    const gam = createFakeGam();
    const url = (p: string) => `https://admanager.googleapis.com/v1/${p}`;
    await gam.fetch(new Request(url('networks/1234/reports/1'), { method: 'DELETE' }));
    await gam.fetch(new Request(url('networks/5678/reports'), {
      method: 'POST',
      body: JSON.stringify({ reportDefinition: { timeZoneSource: 'PUBLISHER', currencyCode: 'USD' } }),
    }));
    await gam.fetch(new Request(url('networks/1234/reports/1:run'), { method: 'POST', body: '{}' }));
    expect(takeViolations()).toEqual(['DELETE networks/1234/reports/1', 'POST networks/5678/reports']);
    expect(gam.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'DELETE networks/1234/reports/1',
      'POST networks/5678/reports',
      'POST networks/1234/reports/1:run',
    ]);
  });

  it('H7: the write guard flags a disallowed write and lets a clean log through', () => {
    // Permanent coverage of the guard's own logic (`findViolations`), not
    // routed through a fake GAM at all — this pins the check itself, not
    // just a fake's use of it.
    const dirty = [
      { method: 'PATCH', path: 'networks/1234/reports/1' },
      { method: 'POST', path: 'networks/1234/orders/9' },
      { method: 'POST', path: 'networks/1234/reports/5:run/extra' },
      { method: 'POST', path: 'networks/1234/reportsX' },
      { method: 'POST', path: 'networks/5678/reports' },
      { method: 'POST', path: 'networks/5678/reports/5:run' },
    ];
    expect(findViolations(dirty, '1234')).toEqual([
      'PATCH networks/1234/reports/1',
      'POST networks/1234/orders/9',
      'POST networks/1234/reports/5:run/extra',
      'POST networks/1234/reportsX',
      'POST networks/5678/reports',
      'POST networks/5678/reports/5:run',
    ]);

    const clean = [
      { method: 'GET', path: 'networks/1234/reports/1' },
      { method: 'GET', path: 'networks/5678/reports/1' },
      { method: 'POST', path: 'networks/1234/reports' },
      { method: 'POST', path: 'networks/1234/reports?x=1' },
      { method: 'POST', path: 'networks/1234/reports/1:run' },
    ];
    expect(findViolations(clean, '1234')).toEqual([]);
  });

  it('H7: every test file runs the write guard', () => {
    const config = readFileSync(fileURLToPath(new URL('../vitest.config.ts', import.meta.url)), 'utf8');
    expect(config).toMatch(/setupFiles:\s*\['tests\/setup\.ts'\]/);
    const setup = readFileSync(fileURLToPath(new URL('./setup.ts', import.meta.url)), 'utf8');
    expect(setup).toMatch(/afterEach\(/);
    expect(setup).toMatch(/takeViolations\(\)/);
  });

  it('D5: a fake GAM records a create without the network zone source and currency', async () => {
    const gam = createFakeGam();
    const create = (reportDefinition: unknown) =>
      gam.fetch('https://admanager.googleapis.com/v1/networks/1234/reports', {
        method: 'POST',
        body: JSON.stringify({ reportDefinition }),
      });
    await create({ timeZoneSource: 'PUBLISHER', currencyCode: 'USD' });
    await create({ timeZoneSource: 'PROVIDED', timeZone: 'Asia/Seoul', currencyCode: 'USD' });
    // A currency the fake network does not use: this one must violate.
    await create({ timeZoneSource: 'PUBLISHER', currencyCode: 'EUR' });
    await create({ dimensions: ['DATE'] });
    const expected = 'POST networks/1234/reports without timeZoneSource PUBLISHER and currencyCode USD';
    expect(takeViolations()).toEqual([expected, expected, expected]);
  });
});
