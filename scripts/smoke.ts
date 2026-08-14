import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRestGamClient } from '../src/gam-client-rest.js';
import { createGoogleAuth, createAuthFetch, resolveAuthSource } from '../src/auth.js';
import { resolveDateRange } from '../src/dates.js';
import { describeLineItemTool } from '../src/tools/describe_line_item.js';
import { createOutputManager } from '../src/output.js';
import { noopLogger } from '../src/log.js';
import type { GAMClient } from '../src/gam-client.js';

async function main(): Promise<void> {
  const networkCode = process.env.GAM_NETWORK_CODE;
  if (!networkCode) {
    process.stderr.write('Set GAM_NETWORK_CODE (and GAM_SERVICE_ACCOUNT_KEY_FILE, or rely on ADC).\n');
    process.exit(2);
  }
  // Same resolution the server uses, so the smoke test authenticates exactly
  // like a real session — key file, inline JSON, or ADC.
  const resolved = resolveAuthSource(process.env);
  if ('error' in resolved) {
    process.stderr.write(`${resolved.error.message} ${resolved.error.hint}\n`);
    process.exit(2);
  }
  const tz = process.env.GAM_TIMEZONE ?? 'America/Los_Angeles';

  const auth = createGoogleAuth(resolved.source);
  const fetchImpl = createAuthFetch(auth);
  const client = createRestGamClient({ networkCode, fetchImpl });

  process.stderr.write('1. Listing 5 most recent orders...\n');
  const orders = await client.listEntities({ entity_type: 'order' });
  process.stderr.write(`   got ${orders.length} orders; first: ${JSON.stringify(orders[0])}\n`);

  process.stderr.write('2. Running tiny report (yesterday, top advertisers, impressions)...\n');
  await tinyReport(client, tz);

  process.stderr.write('3. By-id lookups (line_item / ad_unit / placement — these used to 400)...\n');
  await byIdLookups(client);

  process.stderr.write('4. describe_line_item on one live line item...\n');
  await describeOne(client, tz);

  process.stderr.write('SMOKE OK\n');
}

async function tinyReport(client: GAMClient, tz: string): Promise<void> {
  const range = resolveDateRange({ relative: 'yesterday' }, tz);
  const op = await client.createReport(
    { dimensions: ['ADVERTISER_NAME'], metrics: ['IMPRESSIONS'] },
    range,
  );
  process.stderr.write(`   operation: ${op.operation_name}\n`);
  for (let attempts = 0; attempts < 60; attempts++) {
    const s = await client.pollOperation(op.operation_name);
    if (s.state === 'done') {
      process.stderr.write(`   done; download: ${s.download_url}\n`);
      const path = await client.downloadReport(s.download_url, '/tmp/gam-mcp-smoke.csv.gz');
      process.stderr.write(`   wrote: ${path}\n`);
      return;
    }
    if (s.state === 'failed') throw new Error(`report failed: ${s.reason}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('report timed out after 60 attempts');
}

async function byIdLookups(client: GAMClient): Promise<void> {
  for (const entity_type of ['line_item', 'ad_unit', 'placement'] as const) {
    const some = await client.listEntities({ entity_type, limit: 2 });
    if (some.length === 0) {
      process.stderr.write(`   ${entity_type}: none in this network, skipped\n`);
      continue;
    }
    const ids = some.map((e) => e.id);
    const byId = await client.listEntities({ entity_type, ids });
    if (byId.length !== ids.length) {
      throw new Error(`${entity_type}: by-id returned ${byId.length}/${ids.length}`);
    }
    process.stderr.write(`   ${entity_type}: ${byId.length}/${ids.length} resolved by id\n`);
  }
}

async function describeOne(client: GAMClient, tz: string): Promise<void> {
  const some = await client.listEntities({ entity_type: 'line_item', limit: 1 });
  if (some.length === 0) {
    process.stderr.write('   no line items in this network, skipped\n');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'gam-smoke-'));
  try {
    const r = await describeLineItemTool.handler({ ids: [some[0].id] }, {
      client,
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: tz,
      logger: noopLogger(),
    }) as Record<string, any>;
    if ('error' in r) throw new Error(`describe_line_item: ${JSON.stringify(r.error)}`);
    const li = r.line_items[0];
    const paths = Object.keys(r.resolved_paths);
    // Counts and shape only — no targeting values are printed, so the output
    // is safe to paste anywhere.
    const stillRaw = li.custom_targeting
      .flatMap((c: { key: string; values: string[] }) => [c.key, ...c.values])
      .filter((v: string) => v.startsWith('networks/')).length;
    process.stderr.write(
      `   status=${li.status} type=${li.lineItemType} targeting_keys=${li.targeting ? Object.keys(li.targeting).length : 0}` +
      ` clauses=${li.custom_targeting.length} resolved_paths=${paths.length} unresolved_labels=${stillRaw}\n`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { process.stderr.write(`smoke: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
