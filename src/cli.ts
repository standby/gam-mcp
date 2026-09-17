#!/usr/bin/env node
import { startMcpServer, buildMcpServer, installStdoutGuard } from './server.js';
import { connectHttp } from './http-transport.js';
import { createGoogleAuth, createAuthFetch, resolveAuthSource } from './auth.js';
import { createRestGamClient, withRetries } from './gam-client-rest.js';
import { createReportCache } from './cache.js';
import { createLogger, levelFromEnv } from './log.js';
import { resolvePageRows } from './report-exec.js';
import { createSavedQueryStore, defaultSavedQueriesPath } from './saved-queries.js';
import { checkNetworkIdentity, chooseDateTimeZone, readSettings } from './startup.js';
import { createUsageCounters, instrumentGamClient } from './usage.js';

function stop(message: string): never {
  process.stderr.write(`gam-mcp: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  // Only install the stdout guard for stdio mode — in HTTP mode stdout is
  // free for normal logging since MCP frames go over HTTP, not stdout.
  const httpPort = process.env.GAM_HTTP_PORT ? Number(process.env.GAM_HTTP_PORT) : null;
  if (httpPort === null) installStdoutGuard();
  if (httpPort !== null && (!Number.isFinite(httpPort) || httpPort <= 0 || httpPort > 65535)) {
    stop(`GAM_HTTP_PORT must be a valid port number, got ${process.env.GAM_HTTP_PORT}`);
  }

  // Everything that can be checked without the network is checked first.
  const settings = readSettings(process.env);
  if ('error' in settings) stop(settings.error);
  const { networkCode } = settings;
  const logger = createLogger({ level: levelFromEnv(process.env) });
  const pageRows = resolvePageRows(process.env.GAM_PAGE_ROWS, logger);
  if (typeof pageRows !== 'number') stop(pageRows.error);
  if (process.env.GAM_INLINE_ROW_THRESHOLD !== undefined) {
    logger.warn('config.ignored', {
      variable: 'GAM_INLINE_ROW_THRESHOLD',
      reason: 'results are paged; set GAM_PAGE_ROWS instead',
    });
  }

  const resolved = resolveAuthSource(process.env);
  if ('error' in resolved) stop(`${resolved.error.message}\n  hint: ${resolved.error.hint}`);
  logger.info('auth.source_resolved', { source: resolved.source.type });

  const auth = createGoogleAuth(resolved.source, logger);
  // Transient failures are retried with backoff; a POST only on 429 (spec §2.3).
  const fetchImpl = withRetries(createAuthFetch(auth), { logger });
  const rawClient = createRestGamClient({ networkCode, fetchImpl });

  // Nothing is served until the credential has read the network (spec §2.4).
  const network = await checkNetworkIdentity(rawClient, networkCode, resolved.source.type);
  if ('error' in network) stop(network.error);
  const timezone = chooseDateTimeZone(settings.dateTimeZone, network, logger);

  const usageCounters = createUsageCounters();
  const client = instrumentGamClient(rawClient, usageCounters);
  const reportCache = createReportCache({
    logger,
    ttlMs: settings.cacheTtlMs,
    ...(settings.cacheDir ? { diskDir: settings.cacheDir } : {}),
  });
  const savedQueries = createSavedQueryStore(defaultSavedQueriesPath(process.env));
  const ctx = {
    client,
    timezone,
    networkCode,
    pageRows,
    reportTimeoutMs: settings.reportTimeoutMs,
    reportCache,
    logger,
    savedQueries,
    usageCounters,
  };
  if (httpPort !== null) {
    // A factory: stateless HTTP needs a fresh server per request, not one shared.
    await connectHttp(() => buildMcpServer(ctx, { networkCode }), { port: httpPort, logger });
  } else {
    await startMcpServer(ctx, { networkCode });
  }
}

main().catch((e) => {
  process.stderr.write(`gam-mcp: fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
