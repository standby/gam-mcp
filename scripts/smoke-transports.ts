#!/usr/bin/env node
// The packaged binary, over both transports, against a live network.
//
// Ruling P3-4: the suite proves stdio for StdioServerTransport over generic
// streams, and HTTP for connectHttp in process — neither proves dist/cli.js,
// the thing that actually ships. A real startup needs a live credential and a
// real networks.get, so this cannot live in the test suite. It lives here.
//
// The second run is a FRESH PROCESS on purpose (carried from PR 2's review):
// report reuse is remembered per client, so only a new process can prove a
// report is found again through GAM rather than through memory. The run fails
// if report.name_taken appears — that log line means the name was taken by a
// report whose definition no longer matches, i.e. reuse is broken.
//
// WARNING: this talks to a production network and defines report objects that
// are HIDDEN and CANNOT BE DELETED through the API. Hence the confirm gate.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli.js');

// One definition for every run and both transports, so the whole smoke ever
// defines ONE report in the network. A range that moved with the clock would
// leave a new undeletable report behind every day. Override both if GAM has
// aged this window out of its retention window.
const DATE_START = process.env.GAM_SMOKE_DATE_START ?? '2026-09-01';
const DATE_END = process.env.GAM_SMOKE_DATE_END ?? '2026-09-07';
const QUERY = {
  dimensions: ['ADVERTISER_ID', 'ADVERTISER_NAME'],
  metrics: ['IMPRESSIONS'],
  date_range: { start: DATE_START, end: DATE_END },
};

// Stdio lists these; HTTP does not. The split is built per server, so it has
// to be checked on the real binary in each mode, not just in memory.
const SAVED_QUERY_TOOLS = ['save_query', 'list_saved_queries', 'run_saved_query', 'delete_saved_query'];
const ALWAYS = ['run_report', 'fetch_report_page', 'describe_schema'];

const STARTUP_MS = 90_000;
const REPORT_MS = 180_000;

function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

function stop(message: string): never {
  process.stderr.write(`smoke-transports: ${message}\n`);
  process.exit(2);
}

// Credentials are read from the caller's environment and passed through by
// name; nothing about them is printed. GAM_REPORT_CACHE_DIR is deliberately
// NOT passed: with no disk tier a fresh process starts with an empty cache,
// and that is what forces run 2 down the report-reuse path. A cache hit
// would answer from disk and never look for the report at all.
const PASS_THROUGH = [
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GAM_SERVICE_ACCOUNT_KEY_FILE',
  'GAM_SERVICE_ACCOUNT_KEY_JSON',
  'GAM_TIMEZONE',
  'GAM_REPORT_TIMEOUT_MS',
];

function childEnv(networkCode: string, scratch: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    GAM_NETWORK_CODE: networkCode,
    // report.reused is a debug line, and it is the evidence this run is after.
    GAM_LOG_LEVEL: 'debug',
    // Never touch the developer's saved queries.
    GAM_SAVED_QUERIES_FILE: join(scratch, 'saved-queries.json'),
    ...extra,
  };
  for (const name of PASS_THROUGH) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

type Collected = {
  text: () => string;
  events: () => Array<Record<string, unknown>>;
  saw: (msg: string) => boolean;
  until: (msg: string, ms: number) => Promise<void>;
};

// Accumulates a child's stderr and reads the JSON log lines back out of it.
function collect(stream: Readable | null): Collected {
  let text = '';
  stream?.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
  const events = () => text.split('\n').flatMap((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return parsed && typeof parsed === 'object' ? [parsed as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
  const saw = (msg: string) => events().some((e) => e.msg === msg);
  return {
    text: () => text,
    events,
    saw,
    // ponytail: polls rather than parsing incrementally — 50 ms is invisible
    // next to a live networks.get, and there is exactly one thing to wait for.
    async until(msg, ms) {
      const deadline = Date.now() + ms;
      while (!saw(msg)) {
        if (Date.now() > deadline) {
          throw new Error(`timed out after ${ms} ms waiting for ${msg}\n--- child stderr ---\n${text}`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },
  };
}

function withTimeout<T>(what: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// A port nothing is listening on right now.
// ponytail: bind-then-release races anything else that grabs the port in the
// gap; a busy port surfaces as the CLI's own EADDRINUSE message, so rerun.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('could not find a free port'))));
    });
  });
}

function payloadOf(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const first = content[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`tool result carried no text content: ${JSON.stringify(result).slice(0, 400)}`);
  }
  return JSON.parse(first.text) as Record<string, any>;
}

// What a client does first, over whichever transport it arrived on. Returns
// the report resource name, so the two runs can be compared directly.
async function exercise(client: Client, mode: 'stdio' | 'http'): Promise<string> {
  const server = client.getServerVersion();
  if (server?.name !== 'gam-mcp') {
    throw new Error(`${mode}: server identified itself as ${JSON.stringify(server)}`);
  }

  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const tool of ALWAYS) {
    if (!names.includes(tool)) throw new Error(`${mode}: ${tool} is not listed`);
  }
  const listed = SAVED_QUERY_TOOLS.filter((t) => names.includes(t));
  const wanted = mode === 'stdio' ? SAVED_QUERY_TOOLS.length : 0;
  if (listed.length !== wanted) {
    throw new Error(
      `${mode}: expected ${wanted} saved-query tool(s), got ${listed.length} (${listed.join(', ') || 'none'})`,
    );
  }
  say(`   ${mode}: ${server.name} ${server.version}, ${names.length} tools, ${listed.length} saved-query`);

  const result = await withTimeout(
    `${mode}: run_report`,
    REPORT_MS,
    client.callTool({ name: 'run_report', arguments: QUERY }),
  );
  const payload = payloadOf(result);
  if ((result as { isError?: boolean }).isError || payload.error) {
    throw new Error(`${mode}: run_report failed: ${JSON.stringify(payload.error ?? payload)}`);
  }
  const p = payload.provenance;
  if (typeof p?.report !== 'string') {
    throw new Error(`${mode}: run_report returned no report in its provenance: ${JSON.stringify(p)}`);
  }
  // Counts and resource names only — no row values are printed, so a smoke
  // log carries no publisher data and is safe to paste anywhere.
  say(
    `   ${mode}: report=${p.report} type=${p.report_type} rows=${payload.returned_row_count}` +
    ` total=${payload.total_row_count} cache_hit=${p.cache?.hit}`,
  );
  return p.report;
}

// Pulled straight off find_unused_ad_units.ts's summary template — keep this
// in sync with the literal text at that call site, not with a paraphrase of
// it: "`${unused.length} of ${candidates.length} active, leaf ad units
// flagged (${allUnits.length} listed; ${excluded} excluded as archived,
// non-leaf, or missing a status).`". There is no structured field for these
// two counts (the envelope only carries returned_row_count/total_row_count,
// which is unused.length, not allUnits.length or excluded) so the summary
// prose is the only place they exist; a change to that wording must update
// this pattern too, which is why a non-match below is a hard failure rather
// than a silent skip.
const AD_UNIT_COUNTS = /\((\d+)\s+listed;\s+(\d+)\s+excluded/;

// find_unused_ad_units filters ad units on AdUnit.status === 'ACTIVE' and
// derives leaf-ness from AdUnit.parentAdUnit. Neither field name was ever
// confirmed against the live API -- the 0.6.0 probe never fetched an ad
// unit -- and because a missing status is treated as not-active (absence is
// not permission), a wrong name fails totally, not partially: every unit
// excluded, zero rows, on every call, with no error. No fixture can catch
// this: a fixture is written by whoever wrote the code reading it. Stdio
// only -- this is a field-name check, not a transport check.
async function checkUnusedAdUnits(client: Client): Promise<void> {
  const result = await withTimeout(
    'stdio: find_unused_ad_units',
    REPORT_MS,
    client.callTool({ name: 'find_unused_ad_units', arguments: { max_units: 100 } }),
  );
  const payload = payloadOf(result);
  if ((result as { isError?: boolean }).isError || payload.error) {
    throw new Error(`stdio: find_unused_ad_units failed: ${JSON.stringify(payload.error ?? payload)}`);
  }
  if (typeof payload.summary !== 'string') {
    throw new Error(`stdio: find_unused_ad_units returned no summary: ${JSON.stringify(payload).slice(0, 400)}`);
  }
  const match = AD_UNIT_COUNTS.exec(payload.summary);
  if (!match) {
    // A parse miss is itself the finding, not something to shrug past: it
    // means this check can no longer see its signal (summary wording moved
    // again, as it already has once before), so it must fail loudly rather
    // than let the exclusion check silently pass on undefined counts.
    throw new Error(
      'stdio: find_unused_ad_units summary did not contain the expected "(N listed; M excluded" text -- ' +
      `the wording moved and this check needs updating to match it: ${JSON.stringify(payload.summary)}`,
    );
  }
  const adUnitsListed = Number(match[1]);
  const adUnitsExcluded = Number(match[2]);
  say(
    `   stdio: find_unused_ad_units rows=${payload.returned_row_count}` +
    ` listed=${adUnitsListed} excluded=${adUnitsExcluded}`,
  );

  // The wrong-field-name signature: every listed ad unit excluded. A
  // genuinely empty network (adUnitsListed === 0) is a legitimate pass --
  // absence is not permission here either, so "nothing was listed" must not
  // be conflated with "the fields are fine".
  if (adUnitsListed > 0 && adUnitsExcluded === adUnitsListed) {
    throw new Error(
      `find_unused_ad_units excluded every one of ${adUnitsListed} listed ad units. ` +
      "That is the signature of a wrong field name: check that GAM's AdUnit resource " +
      'really exposes `status` and `parentAdUnit` (neither was ever confirmed by probe).',
    );
  }
}

// Run 1. The client starts the binary itself, exactly as an MCP host does.
async function overStdio(networkCode: string, scratch: string): Promise<Run> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI],
    env: childEnv(networkCode, scratch),
    stderr: 'pipe',
  });
  // The PassThrough exists from construction, so nothing is missed before start.
  const logs = collect(transport.stderr as Readable | null);
  const client = new Client({ name: 'gam-mcp-smoke-stdio', version: '1' });
  try {
    await withTimeout('stdio: initialize', STARTUP_MS, client.connect(transport));
    const report = await exercise(client, 'stdio');
    await checkUnusedAdUnits(client);
    return { report, logs };
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- child stderr ---\n${logs.text()}`);
  } finally {
    await client.close().catch(() => {});
  }
}

// Run 2, in a fresh process: the same query again, over HTTP this time.
async function overHttp(networkCode: string, scratch: string): Promise<Run> {
  const port = await freePort();
  const token = randomBytes(24).toString('hex');
  const child: ChildProcess = spawn(process.execPath, [CLI], {
    env: childEnv(networkCode, scratch, {
      GAM_HTTP_PORT: String(port),
      GAM_HTTP_BEARER_TOKEN: token,
      GAM_HTTP_ALLOWED_HOSTS: '127.0.0.1',
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const logs = collect(child.stderr);
  const client = new Client({ name: 'gam-mcp-smoke-http', version: '1' });
  try {
    // A child that dies during startup must lose the race, not keep the wait
    // polling for its full timeout. The no-op catch is on a derived promise,
    // so `exited` still rejects into the race but never goes unhandled once
    // the finally block kills the process.
    const exited = new Promise<never>((_, reject) => {
      child.once('exit', (code, signal) =>
        reject(new Error(`the HTTP process exited (code=${code} signal=${signal}) before it listened`)));
    });
    exited.catch(() => {});
    await Promise.race([logs.until('http.listening', STARTUP_MS), exited]);

    // The deployment probe: no credential, no Host check, says only "up".
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    if (health.status !== 200) throw new Error(`http: /healthz answered ${health.status}`);
    say(`   http: /healthz ${JSON.stringify(await health.json())}`);

    // The boundary, on the real binary: no token, no service — and the
    // connection comes back rather than stalling (the 0.6.0 refusal fix).
    const refused = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{}',
    });
    if (refused.status !== 401) throw new Error(`http: an unauthenticated /mcp POST answered ${refused.status}, want 401`);
    await refused.text();
    say('   http: unauthenticated /mcp refused 401');

    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    await withTimeout('http: initialize', STARTUP_MS, client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })));
    const report = await exercise(client, 'http');
    return { report, logs };
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- child stderr ---\n${logs.text()}`);
  } finally {
    await client.close().catch(() => {});
    child.kill('SIGTERM');
  }
}

// report.name_taken means GAM holds a report under the reuse name whose
// definition no longer matches — every later run would define another one.
type Run = { report: string; logs: Collected };

function checkReuse(stdio: Run, http: Run): void {
  for (const [mode, logs] of [['stdio', stdio.logs], ['http', http.logs]] as const) {
    const taken = logs.events().filter((e) => e.msg === 'report.name_taken');
    if (taken.length > 0) {
      throw new Error(
        `${mode}: report.name_taken — report reuse is broken. ` +
        taken.map((e) => `differing_keys=${JSON.stringify(e.differing_keys)}`).join('; '),
      );
    }
  }
  if (!http.logs.saw('report.reused')) {
    const what = http.logs.saw('report.list_filter_rejected')
      ? 'GAM refused the displayName filter, so the report could not be looked up'
      : `it logged ${JSON.stringify(http.logs.events().filter((e) => String(e.msg).startsWith('report.')).map((e) => e.msg))}`;
    throw new Error(`the fresh process did not reuse the report: ${what}`);
  }
  if (stdio.report !== http.report) {
    throw new Error(`the two runs used different reports: ${stdio.report} then ${http.report}`);
  }
  say(`   reuse: the fresh HTTP process found ${http.report} again`);
}

async function main(): Promise<void> {
  const networkCode = process.env.GAM_NETWORK_CODE;
  if (!networkCode) stop('set GAM_NETWORK_CODE (and a credential: GAM_SERVICE_ACCOUNT_KEY_FILE, or rely on ADC)');
  if (!existsSync(CLI)) stop(`${CLI} does not exist — run "npm run build" first; this drives the packaged binary`);
  if (process.env.GAM_SMOKE_CONFIRM !== 'yes' && !process.argv.includes('--yes')) {
    stop(
      `this runs against live network ${networkCode} and defines report objects that are hidden and ` +
      'cannot be deleted through the API. Re-run with --yes (or GAM_SMOKE_CONFIRM=yes) to confirm.',
    );
  }

  const scratch = mkdtempSync(join(tmpdir(), 'gam-smoke-transports-'));
  try {
    say(`1. stdio: starting ${CLI} as a child process...`);
    const stdio = await overStdio(networkCode, scratch);

    say('2. http: a fresh process, GAM_HTTP_PORT set, same query...');
    const http = await overHttp(networkCode, scratch);

    say('3. report reuse across processes...');
    checkReuse(stdio, http);

    say('SMOKE OK — dist/cli.js serves both transports and reuses its report across processes');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stderr.write(`smoke-transports: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
