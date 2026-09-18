import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cacheDirFor,
  chooseDateTimeZone,
  checkNetworkIdentity,
  ignoredInStdio,
  openReportCache,
  readHttpSettings,
  readSettings,
} from '../src/startup.js';
import { createRestGamClient } from '../src/gam-client-rest.js';
import { CredentialError, gamError } from '../src/errors.js';
import { createLogger } from '../src/log.js';
import { createFakeGam } from './fake-gam.js';

const NETWORK_INFO = { networkCode: '1234', timeZone: 'Asia/Tokyo', currencyCode: 'USD' };
const CODE = { GAM_NETWORK_CODE: '1234' };
const AUTH_HINT = gamError('AUTH_FAILED').error.hint;
const RETRY_HINT = 'Google Ad Manager could not be reached or is rate-limiting; retry later.';

describe('readSettings', () => {
  it('uses the defaults when only the network code is set', () => {
    expect(readSettings(CODE)).toEqual({
      networkCode: '1234', dateTimeZone: undefined, reportTimeoutMs: 300_000, cacheTtlMs: 3_600_000, cacheDir: undefined,
    });
  });

  it('requires a numeric network code', () => {
    expect(readSettings({})).toEqual({ error: 'GAM_NETWORK_CODE is required' });
    for (const bad of ['12a4', '1234 ', '../1234', '12.34']) {
      const r = readSettings({ GAM_NETWORK_CODE: bad });
      if (!('error' in r)) throw new Error(`expected ${JSON.stringify(bad)} to be refused`);
      expect(r.error).toContain('GAM_NETWORK_CODE');
    }
  });

  it('reads every setting it owns', () => {
    expect(readSettings({
      ...CODE,
      GAM_TIMEZONE: 'asia/seoul',
      GAM_REPORT_TIMEOUT_MS: '90000',
      GAM_REPORT_CACHE_TTL_MS: '0',
      GAM_REPORT_CACHE_DIR: '/var/cache/gam-mcp',
    })).toEqual({
      networkCode: '1234', dateTimeZone: 'Asia/Seoul', reportTimeoutMs: 90_000, cacheTtlMs: 0, cacheDir: '/var/cache/gam-mcp',
    });
  });

  it('treats empty values as unset', () => {
    expect(readSettings({ ...CODE, GAM_TIMEZONE: '', GAM_REPORT_TIMEOUT_MS: '', GAM_REPORT_CACHE_DIR: '' })).toEqual({
      networkCode: '1234', dateTimeZone: undefined, reportTimeoutMs: 300_000, cacheTtlMs: 3_600_000, cacheDir: undefined,
    });
  });

  it('D4: an unknown zone is an error naming GAM_TIMEZONE', () => {
    const r = readSettings({ ...CODE, GAM_TIMEZONE: 'Mars/Olympus' });
    if (!('error' in r)) throw new Error('expected an error');
    expect(r.error).toContain('GAM_TIMEZONE');
    expect(r.error).toContain('Mars/Olympus');
  });

  it('D4: a raw UTC offset is not an IANA name, and the error names GAM_TIMEZONE', () => {
    const r = readSettings({ ...CODE, GAM_TIMEZONE: '+08:00' });
    if (!('error' in r)) throw new Error('expected an error');
    expect(r.error).toContain('GAM_TIMEZONE');
    expect(r.error).toContain('+08:00');
  });

  it.each([
    ['GAM_REPORT_TIMEOUT_MS', '0'],
    ['GAM_REPORT_TIMEOUT_MS', 'soon'],
    ['GAM_REPORT_CACHE_TTL_MS', '-1'],
    ['GAM_REPORT_CACHE_TTL_MS', '1.5'],
    ['GAM_REPORT_TIMEOUT_MS', '1e3'],
    ['GAM_REPORT_TIMEOUT_MS', ' 5000'],
    ['GAM_REPORT_CACHE_TTL_MS', '0x10'],
    ['GAM_REPORT_CACHE_TTL_MS', '60000.0'],
  ])('rejects %s=%s', (name, value) => {
    const r = readSettings({ ...CODE, [name]: value });
    if (!('error' in r)) throw new Error('expected an error');
    expect(r.error).toContain(name);
  });
});

describe('readHttpSettings (spec §2.7)', () => {
  const PORT = { GAM_HTTP_PORT: '8080' };

  it('is null in stdio mode', () => {
    expect(readHttpSettings({})).toBeNull();
    expect(readHttpSettings({ GAM_HTTP_PORT: '', GAM_HTTP_BEARER_TOKEN: 'x' })).toBeNull();
  });

  it('reads the port, the token and the host list', () => {
    expect(readHttpSettings(PORT)).toEqual({ port: 8080, bearerToken: undefined, allowedHosts: undefined });
    expect(readHttpSettings({
      ...PORT,
      GAM_HTTP_BEARER_TOKEN: 'abc.DEF-123_~+/=',
      GAM_HTTP_ALLOWED_HOSTS: ' GAM-MCP.internal, localhost ,,[::1]',
    })).toEqual({ port: 8080, bearerToken: 'abc.DEF-123_~+/=', allowedHosts: ['gam-mcp.internal', 'localhost', '[::1]'] });
  });

  it('treats empty token and host values as unset', () => {
    expect(readHttpSettings({ ...PORT, GAM_HTTP_BEARER_TOKEN: '', GAM_HTTP_ALLOWED_HOSTS: '  ' }))
      .toEqual({ port: 8080, bearerToken: undefined, allowedHosts: undefined });
  });

  it.each(['0', '65536', '80.5', '1e3', ' 80', 'http'])('refuses GAM_HTTP_PORT=%j, quoting it', (port) => {
    expect(readHttpSettings({ GAM_HTTP_PORT: port })).toEqual({
      error: `GAM_HTTP_PORT must be a valid port number, got ${JSON.stringify(port)}`,
    });
  });

  // A tab and an accented letter, built from their codes.
  const TAB = String.fromCharCode(9);
  const E_ACUTE = String.fromCharCode(233);
  it.each(['has space', `tab${TAB}here`, `caf${E_ACUTE}`])('refuses a token that is not printable ASCII, without quoting it', (token) => {
    const r = readHttpSettings({ ...PORT, GAM_HTTP_BEARER_TOKEN: token });
    expect(r).toEqual({ error: 'GAM_HTTP_BEARER_TOKEN must be printable ASCII with no spaces' });
  });

  it.each([
    ['gam-mcp.internal:8080', 'gam-mcp.internal:8080'],
    ['http://gam-mcp.internal', 'http://gam-mcp.internal'],
    ['gam-mcp.internal/mcp', 'gam-mcp.internal/mcp'],
    ['a.internal,bad host', 'bad host'],
  ])('refuses GAM_HTTP_ALLOWED_HOSTS=%j, naming the entry', (hosts, entry) => {
    expect(readHttpSettings({ ...PORT, GAM_HTTP_ALLOWED_HOSTS: hosts })).toEqual({
      error: `GAM_HTTP_ALLOWED_HOSTS must list host names without ports, separated by commas; ${JSON.stringify(entry)} is not one`,
    });
  });

  it('refuses a host list with no host in it', () => {
    expect(readHttpSettings({ ...PORT, GAM_HTTP_ALLOWED_HOSTS: ' , ' })).toEqual({
      error: 'GAM_HTTP_ALLOWED_HOSTS names no host: " , "',
    });
  });

  it('names the HTTP settings a stdio process ignores', () => {
    expect(ignoredInStdio({ GAM_HTTP_BEARER_TOKEN: 'x', GAM_HTTP_ALLOWED_HOSTS: 'h' }))
      .toEqual(['GAM_HTTP_BEARER_TOKEN', 'GAM_HTTP_ALLOWED_HOSTS']);
    expect(ignoredInStdio({ GAM_HTTP_BEARER_TOKEN: '' })).toEqual([]);
  });
});

describe('checkNetworkIdentity', () => {
  const restClient = (gam: ReturnType<typeof createFakeGam>) =>
    createRestGamClient({ networkCode: '1234', fetchImpl: gam.fetch });

  it('returns the network zone and currency from networks.get', async () => {
    expect(await checkNetworkIdentity(restClient(createFakeGam()), '1234', 'file')).toEqual(NETWORK_INFO);
  });

  it('D3: a 403 stops startup with GAM status, the source and the AUTH_FAILED hint', async () => {
    const gam = createFakeGam();
    gam.inject('GET', /^networks\/1234$/, {
      status: 403,
      body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } },
    });
    const r = await checkNetworkIdentity(restClient(gam), '1234', 'adc');
    if (!('error' in r)) throw new Error('expected an error');
    expect(r.error).toContain('cannot read network 1234 with the adc credential');
    expect(r.error).toContain('GAM answered HTTP 403 PERMISSION_DENIED');
    expect(r.error).toContain(`hint: ${AUTH_HINT}`);
  });

  it('D3: a 401 gives the credential hint too', async () => {
    const gam = createFakeGam();
    gam.inject('GET', /^networks\/1234$/, { status: 401, body: { error: { code: 401, status: 'UNAUTHENTICATED' } } });
    const r = await checkNetworkIdentity(restClient(gam), '1234', 'file');
    if (!('error' in r)) throw new Error('expected an error');
    expect(r.error).toContain('GAM answered HTTP 401 UNAUTHENTICATED');
    expect(r.error).toContain(`hint: ${AUTH_HINT}`);
  });

  it('names a credential failure without quoting the credential, with the credential hint', async () => {
    const client = { getNetwork: async () => { throw new CredentialError('json', 'SyntaxError'); } };
    const r = await checkNetworkIdentity(client, '1234', 'json');
    if (!('error' in r)) throw new Error('expected an error');
    expect(r.error).toContain('with the json credential');
    expect(r.error).toContain('GAM was not reached: the json credential could not produce an access token (SyntaxError)');
    expect(r.error).toContain(`hint: ${AUTH_HINT}`);
  });

  it('a 404 says to check GAM_NETWORK_CODE', async () => {
    const gam = createFakeGam();
    gam.inject('GET', /^networks\/1234$/, { status: 404, body: { error: { code: 404, status: 'NOT_FOUND' } } });
    const r = await checkNetworkIdentity(restClient(gam), '1234', 'file');
    if (!('error' in r)) throw new Error('expected an error');
    expect(r.error).toContain('GAM answered HTTP 404 NOT_FOUND');
    expect(r.error).toMatch(/hint: Check GAM_NETWORK_CODE/);
    expect(r.error).not.toContain(AUTH_HINT);
  });

  it.each([429, 500, 503])('a %i says GAM could not be reached or is rate-limiting', async (status) => {
    const gam = createFakeGam();
    gam.inject('GET', /^networks\/1234$/, { status });
    const r = await checkNetworkIdentity(restClient(gam), '1234', 'adc');
    if (!('error' in r)) throw new Error('expected an error');
    expect(r.error).toContain(`GAM answered HTTP ${status}`);
    expect(r.error).toContain(`hint: ${RETRY_HINT}`);
    expect(r.error).not.toContain(AUTH_HINT);
  });

  it('a request that never reaches GAM says to retry later', async () => {
    const gam = createFakeGam();
    gam.inject('GET', /^networks\/1234$/, 'network-error');
    const r = await checkNetworkIdentity(restClient(gam), '1234', 'adc');
    if (!('error' in r)) throw new Error('expected an error');
    expect(r.error).toContain('GAM could not be read: fetch failed');
    expect(r.error).toContain(`hint: ${RETRY_HINT}`);
    expect(r.error).not.toContain(AUTH_HINT);
  });

  it.each(['timeZone', 'currencyCode'])('an answer without %s names the missing field', async (field) => {
    const gam = createFakeGam();
    delete gam.network[field];
    const r = await checkNetworkIdentity(restClient(gam), '1234', 'file');
    if (!('error' in r)) throw new Error('expected an error');
    expect(r.error).toContain(`GAM's answer has no ${field}`);
    expect(r.error).toMatch(new RegExp(`hint: .*\\b${field}\\b`));
    expect(r.error).not.toContain(AUTH_HINT);
  });

  it('refuses a network zone this runtime does not know', async () => {
    const gam = createFakeGam();
    gam.network.timeZone = 'Mars/Olympus';
    const r = await checkNetworkIdentity(restClient(gam), '1234', 'file');
    expect(r).toEqual({ error: expect.stringContaining('"Mars/Olympus"') });
  });
});

describe('chooseDateTimeZone', () => {
  function recording() {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({ level: 'debug', sink: (l) => { lines.push(JSON.parse(l)); } });
    return { lines, logger };
  }

  it('D4: unset means the network zone, and startup says so once', () => {
    const { lines, logger } = recording();
    expect(chooseDateTimeZone(undefined, NETWORK_INFO, logger)).toBe('Asia/Tokyo');
    expect(lines).toEqual([expect.objectContaining({
      level: 'info', msg: 'startup.identity', network_code: '1234', currency_code: 'USD',
      report_time_zone: 'Asia/Tokyo', date_time_zone: 'Asia/Tokyo', zones_differ: false,
    })]);
  });

  it('D4: a different zone is accepted with one info line naming both', () => {
    const { lines, logger } = recording();
    expect(chooseDateTimeZone('Asia/Seoul', NETWORK_INFO, logger)).toBe('Asia/Seoul');
    expect(lines).toEqual([expect.objectContaining({
      level: 'info', msg: 'startup.identity',
      report_time_zone: 'Asia/Tokyo', date_time_zone: 'Asia/Seoul', zones_differ: true,
    })]);
  });
});

describe('openReportCache', () => {
  function withDir(run: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'gam-startup-'));
    try {
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const settingsFor = (env: NodeJS.ProcessEnv) => {
    const s = readSettings({ ...CODE, ...env });
    if ('error' in s) throw new Error(s.error);
    return s;
  };

  it('keeps entries in memory only when no directory is set', () => {
    const cache = openReportCache(settingsFor({}), createLogger({ level: 'error' }));
    expect(cache).not.toHaveProperty('error');
  });

  it("creates the network's directory under GAM_REPORT_CACHE_DIR", () => withDir((dir) => {
    const cache = openReportCache(settingsFor({ GAM_REPORT_CACHE_DIR: dir }), createLogger({ level: 'error' }));
    expect(cache).not.toHaveProperty('error');
    expect(statSync(join(dir, '1234')).isDirectory()).toBe(true);
  }));

  it('a GAM_REPORT_CACHE_DIR that cannot be created is an error naming it', () => withDir((dir) => {
    const file = join(dir, 'not-a-directory');
    writeFileSync(file, '');
    const r = openReportCache(settingsFor({ GAM_REPORT_CACHE_DIR: join(file, 'cache') }), createLogger({ level: 'error' }));
    if (!('error' in r)) throw new Error('expected an error');
    expect(r.error).toContain(`GAM_REPORT_CACHE_DIR=${JSON.stringify(join(file, 'cache'))}`);
    expect(r.error).toContain('ENOTDIR');
    expect(existsSync(join(file, 'cache'))).toBe(false);
  }));
});

describe('cacheDirFor', () => {
  it('keeps each network in its own directory', () => {
    const settings = readSettings({ ...CODE, GAM_REPORT_CACHE_DIR: '/var/cache/gam-mcp' });
    if ('error' in settings) throw new Error(settings.error);
    expect(cacheDirFor(settings)).toBe('/var/cache/gam-mcp/1234');
    const none = readSettings(CODE);
    if ('error' in none) throw new Error(none.error);
    expect(cacheDirFor(none)).toBeUndefined();
  });
});
