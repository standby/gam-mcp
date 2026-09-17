import { describe, it, expect } from 'vitest';
import { chooseDateTimeZone, checkNetworkIdentity, readSettings } from '../src/startup.js';
import { createRestGamClient } from '../src/gam-client-rest.js';
import { CredentialError, gamError } from '../src/errors.js';
import { createLogger } from '../src/log.js';
import { createFakeGam } from './fake-gam.js';

const NETWORK_INFO = { networkCode: '1234', timeZone: 'Asia/Tokyo', currencyCode: 'USD' };
const CODE = { GAM_NETWORK_CODE: '1234' };

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

  it.each([
    ['GAM_REPORT_TIMEOUT_MS', '0'],
    ['GAM_REPORT_TIMEOUT_MS', 'soon'],
    ['GAM_REPORT_CACHE_TTL_MS', '-1'],
    ['GAM_REPORT_CACHE_TTL_MS', '1.5'],
  ])('rejects %s=%s', (name, value) => {
    const r = readSettings({ ...CODE, [name]: value });
    if (!('error' in r)) throw new Error('expected an error');
    expect(r.error).toContain(name);
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
    expect(r.error).toContain(gamError('AUTH_FAILED').error.hint);
  });

  it('names a credential failure without quoting the credential', async () => {
    const client = { getNetwork: async () => { throw new CredentialError('json', 'SyntaxError'); } };
    const r = await checkNetworkIdentity(client, '1234', 'json');
    if (!('error' in r)) throw new Error('expected an error');
    expect(r.error).toContain('with the json credential');
    expect(r.error).toContain('GAM was not reached: the json credential could not produce an access token (SyntaxError)');
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
