#!/usr/bin/env node
import { startMcpServer, buildMcpServer, installStdoutGuard } from './server.js';
import { connectHttp } from './http-transport.js';
import { createGoogleAuth, createAuthFetch, resolveAuthSource } from './auth.js';
import { createRestGamClient, withRetries } from './gam-client-rest.js';
import { createReportCache } from './cache.js';
import { createLogger, levelFromEnv } from './log.js';
import { resolvePageRows } from './report-exec.js';
import { createSavedQueryStore, defaultSavedQueriesPath } from './saved-queries.js';
import { createUsageCounters, instrumentGamClient } from './usage.js';

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`gam-mcp: ${name} is required\n`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  // Only install the stdout guard for stdio mode — in HTTP mode stdout is
  // free for normal logging since MCP frames go over HTTP, not stdout.
  const httpPort = process.env.GAM_HTTP_PORT ? Number(process.env.GAM_HTTP_PORT) : null;
  if (httpPort === null) installStdoutGuard();

  const networkCode = requiredEnv('GAM_NETWORK_CODE');
  const timezone = process.env.GAM_TIMEZONE ?? 'UTC';
  const reportTimeoutMs = Number(process.env.GAM_REPORT_TIMEOUT_MS ?? 300_000);

  const logger = createLogger({ level: levelFromEnv(process.env) });

  const pageRows = resolvePageRows(process.env.GAM_PAGE_ROWS, logger);
  if (typeof pageRows !== 'number') {
    process.stderr.write(`gam-mcp: ${pageRows.error}\n`);
    process.exit(2);
  }

  if (process.env.GAM_INLINE_ROW_THRESHOLD !== undefined) {
    logger.warn('config.ignored', {
      variable: 'GAM_INLINE_ROW_THRESHOLD',
      reason: 'results are paged; set GAM_PAGE_ROWS instead',
    });
  }

  const resolved = resolveAuthSource(process.env);
  if ('error' in resolved) {
    process.stderr.write(`gam-mcp: ${resolved.error.message}\n  hint: ${resolved.error.hint}\n`);
    process.exit(2);
  }
  logger.info('auth.source_resolved', { source: resolved.source.type });

  const auth = createGoogleAuth(resolved.source, logger);
  const authFetch = createAuthFetch(auth);
  // Retry transient failures (429 quota, 5xx, network) with exponential
  // backoff so a single hiccup doesn't kill a multi-step LLM session.
  const fetchImpl = withRetries(authFetch, { logger });
  const rawClient = createRestGamClient({ networkCode, fetchImpl });
  const usageCounters = createUsageCounters();
  const client = instrumentGamClient(rawClient, usageCounters);

  const reportCache = createReportCache({
    logger,
    ...(process.env.GAM_REPORT_CACHE_DIR && { diskDir: process.env.GAM_REPORT_CACHE_DIR }),
    ...(process.env.GAM_REPORT_CACHE_TTL_MS && { ttlMs: Number(process.env.GAM_REPORT_CACHE_TTL_MS) }),
  });
  const savedQueries = createSavedQueryStore(defaultSavedQueriesPath(process.env));
  const ctx = { client, timezone, networkCode, pageRows, reportTimeoutMs, reportCache, logger, savedQueries, usageCounters };
  if (httpPort !== null) {
    if (!Number.isFinite(httpPort) || httpPort <= 0 || httpPort > 65535) {
      process.stderr.write(`gam-mcp: GAM_HTTP_PORT must be a valid port number, got ${process.env.GAM_HTTP_PORT}\n`);
      process.exit(2);
    }
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
