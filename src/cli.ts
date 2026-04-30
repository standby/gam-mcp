#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMcpServer, installStdoutGuard } from './server.js';
import { createOutputManager } from './output.js';
import { createGoogleAuth, createAuthFetch } from './auth.js';
import { createRestGamClient } from './gam-client-rest.js';

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`gam-mcp: ${name} is required\n`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  installStdoutGuard();

  const networkCode = requiredEnv('GAM_NETWORK_CODE');
  const keyFile = requiredEnv('GAM_SERVICE_ACCOUNT_KEY_FILE');
  const timezone = process.env.GAM_TIMEZONE ?? 'UTC';
  const inlineThreshold = Number(process.env.GAM_INLINE_ROW_THRESHOLD ?? 200);
  const reportTimeoutMs = Number(process.env.GAM_REPORT_TIMEOUT_MS ?? 300_000);

  const tempDir = mkdtempSync(join(tmpdir(), `gam-mcp-${process.pid}-`));
  const output = createOutputManager({ tempDir, inlineThreshold });

  const auth = createGoogleAuth(keyFile);
  const authFetch = createAuthFetch(auth);
  const client = createRestGamClient({ networkCode, fetchImpl: authFetch });

  const cleanup = () => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await startMcpServer({ client, output, timezone, reportTimeoutMs });
}

main().catch((e) => {
  process.stderr.write(`gam-mcp: fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
