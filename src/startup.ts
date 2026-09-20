import { join } from 'node:path';
import { createReportCache, type ReportCache } from './cache.js';
import { CredentialError, gamError } from './errors.js';
import { GamHttpError, NetworkFieldMissingError, type GAMClient, type NetworkInfo } from './gam-client.js';
import type { Logger } from './log.js';
import { canonicalTimeZone } from './zones.js';
import { hostnameOf, wholeNumber } from './parse.js';

export const DEFAULT_REPORT_TIMEOUT_MS = 300_000;
export const DEFAULT_REPORT_CACHE_TTL_MS = 3_600_000;

export type Settings = {
  // GAM_NETWORK_CODE, digits only: it is placed into resource names and into
  // the pattern cursors are checked against.
  networkCode: string;
  // GAM_TIMEZONE, canonicalised; undefined means "the network's zone".
  dateTimeZone: string | undefined;
  reportTimeoutMs: number;
  cacheTtlMs: number;
  cacheDir: string | undefined;
};

function integerSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
): number | { error: string } {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = wholeNumber(raw);
  if (n === null || n < min) {
    return { error: `${name} must be a whole number of milliseconds, at least ${min}; got ${JSON.stringify(raw)}` };
  }
  return n;
}

// The settings that can be checked before any request. Each error names its
// variable; the caller stops startup with exit code 2.
export function readSettings(env: NodeJS.ProcessEnv): Settings | { error: string } {
  const networkCode = env.GAM_NETWORK_CODE;
  if (!networkCode) return { error: 'GAM_NETWORK_CODE is required' };
  if (!/^\d+$/.test(networkCode)) {
    return { error: `GAM_NETWORK_CODE must be the numeric network code, got ${JSON.stringify(networkCode)}` };
  }
  let dateTimeZone: string | undefined;
  const zone = env.GAM_TIMEZONE;
  if (zone !== undefined && zone !== '') {
    const canonical = canonicalTimeZone(zone);
    if (!canonical) {
      return { error: `GAM_TIMEZONE=${JSON.stringify(zone)} is not an IANA time zone name (for example Asia/Seoul)` };
    }
    dateTimeZone = canonical;
  }
  const reportTimeoutMs = integerSetting(env, 'GAM_REPORT_TIMEOUT_MS', DEFAULT_REPORT_TIMEOUT_MS, 1);
  if (typeof reportTimeoutMs !== 'number') return reportTimeoutMs;
  const cacheTtlMs = integerSetting(env, 'GAM_REPORT_CACHE_TTL_MS', DEFAULT_REPORT_CACHE_TTL_MS, 0);
  if (typeof cacheTtlMs !== 'number') return cacheTtlMs;
  return { networkCode, dateTimeZone, reportTimeoutMs, cacheTtlMs, cacheDir: env.GAM_REPORT_CACHE_DIR || undefined };
}

export type HttpSettings = {
  port: number;
  // GAM_HTTP_BEARER_TOKEN. Never logged or quoted.
  bearerToken: string | undefined;
  // GAM_HTTP_ALLOWED_HOSTS: lower-case host names; undefined means no Host check.
  allowedHosts: string[] | undefined;
};

const HTTP_ONLY = ['GAM_HTTP_BEARER_TOKEN', 'GAM_HTTP_ALLOWED_HOSTS'] as const;

// The HTTP settings (spec §2.7), or null when GAM_HTTP_PORT is unset or empty
// (stdio mode). Each error names its variable; none quotes the token.
export function readHttpSettings(env: NodeJS.ProcessEnv): HttpSettings | null | { error: string } {
  const rawPort = env.GAM_HTTP_PORT;
  if (rawPort === undefined || rawPort === '') return null;
  const port = wholeNumber(rawPort);
  if (port === null || port < 1 || port > 65_535) {
    return { error: `GAM_HTTP_PORT must be a valid port number, got ${JSON.stringify(rawPort)}` };
  }
  const bearerToken = env.GAM_HTTP_BEARER_TOKEN || undefined;
  if (bearerToken !== undefined && ![...bearerToken].every((c) => c > ' ' && c <= '~')) {
    return { error: 'GAM_HTTP_BEARER_TOKEN must be printable ASCII with no spaces' };
  }
  const allowedHosts = hostList(env.GAM_HTTP_ALLOWED_HOSTS);
  if (allowedHosts !== undefined && 'error' in allowedHosts) return allowedHosts;
  return { port, bearerToken, allowedHosts };
}

function hostList(raw: string | undefined): string[] | undefined | { error: string } {
  if (raw === undefined || raw.trim() === '') return undefined;
  const hosts = raw.split(',').map((h) => h.trim()).filter((h) => h !== '');
  if (hosts.length === 0) return { error: `GAM_HTTP_ALLOWED_HOSTS names no host: ${JSON.stringify(raw)}` };
  for (const host of hosts) {
    if (hostnameOf(host) !== host.toLowerCase()) {
      return {
        error: `GAM_HTTP_ALLOWED_HOSTS must list host names without ports, separated by commas; ${JSON.stringify(host)} is not one`,
      };
    }
  }
  return hosts.map((h) => h.toLowerCase());
}

// Settings that only HTTP mode reads, set in stdio mode.
export function ignoredInStdio(env: NodeJS.ProcessEnv): string[] {
  return HTTP_ONLY.filter((name) => env[name]);
}

// networks.get with the configured credential, before anything is served
// (spec §2.4). The error names the credential source, what GAM answered and a
// hint for that cause, never anything the credential contains.
export async function checkNetworkIdentity(
  client: Pick<GAMClient, 'getNetwork'>,
  networkCode: string,
  source: 'file' | 'json' | 'adc',
): Promise<NetworkInfo | { error: string }> {
  let network: NetworkInfo;
  try {
    network = await client.getNetwork();
  } catch (e) {
    return {
      error: `cannot read network ${networkCode} with the ${source} credential (${describeFailure(e)}).\n` +
        `  hint: ${hintFor(e)}`,
    };
  }
  const timeZone = canonicalTimeZone(network.timeZone);
  if (!timeZone) {
    return {
      error: `network ${networkCode} reports the time zone ${JSON.stringify(network.timeZone)}, which this Node runtime does not know`,
    };
  }
  return { ...network, timeZone };
}

function describeFailure(e: unknown): string {
  if (e instanceof GamHttpError) return `GAM answered HTTP ${e.status}${e.gamStatus ? ` ${e.gamStatus}` : ''}`;
  if (e instanceof CredentialError) return `GAM was not reached: ${e.message}`;
  if (e instanceof NetworkFieldMissingError) return `GAM's answer has no ${e.field}`;
  return `GAM could not be read: ${e instanceof Error ? e.message : String(e)}`;
}

const RETRY_LATER = 'Google Ad Manager could not be reached or is rate-limiting; retry later.';

// What to do about a failed identity check, by its cause. A failure that is
// not an answer from GAM is a request that never got one.
function hintFor(e: unknown): string {
  if (e instanceof NetworkFieldMissingError) {
    return `networks.get answered without the network's ${e.field}, which every report needs; retry later, and report it if it persists.`;
  }
  if (e instanceof GamHttpError) {
    if (e.status === 404) return 'Check GAM_NETWORK_CODE: GAM has no network with that code that this credential can read.';
    if (e.status === 429 || e.status >= 500) return RETRY_LATER;
    return gamError('AUTH_FAILED').error.hint;
  }
  if (e instanceof CredentialError) return gamError('AUTH_FAILED').error.hint;
  return RETRY_LATER;
}

// The disk tier for one network: the cache key does not name the network, so
// two networks sharing GAM_REPORT_CACHE_DIR must not share entries.
export function cacheDirFor(settings: Settings): string | undefined {
  return settings.cacheDir ? join(settings.cacheDir, settings.networkCode) : undefined;
}

// The report cache these settings describe. A GAM_REPORT_CACHE_DIR whose
// directory cannot be created is an error naming the variable.
export function openReportCache(settings: Settings, logger: Logger): ReportCache | { error: string } {
  const diskDir = cacheDirFor(settings);
  try {
    return createReportCache({
      networkCode: settings.networkCode,
      ttlMs: settings.cacheTtlMs,
      logger,
      ...(diskDir && { diskDir }),
    });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'unknown error';
    return {
      error: `GAM_REPORT_CACHE_DIR=${JSON.stringify(settings.cacheDir)} cannot be used: ` +
        `the directory ${JSON.stringify(diskDir)} could not be created (${code})`,
    };
  }
}

// GAM_TIMEZONE chooses calendar dates; unset, it is the network's zone, and a
// different zone is allowed (spec D-4). One line names both zones.
export function chooseDateTimeZone(setting: string | undefined, network: NetworkInfo, logger: Logger): string {
  const dateTimeZone = setting ?? network.timeZone;
  logger.info('startup.identity', {
    network_code: network.networkCode,
    currency_code: network.currencyCode,
    report_time_zone: network.timeZone,
    date_time_zone: dateTimeZone,
    zones_differ: dateTimeZone !== network.timeZone,
  });
  return dateTimeZone;
}
