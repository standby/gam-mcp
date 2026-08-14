import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRestGamClient, withRetries } from '../src/gam-client-rest.js';
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
  // Same retry wrapper the server installs (src/cli.ts), so the smoke run
  // absorbs 429s the way a real session does instead of dropping them.
  const fetchImpl = withRetries(createAuthFetch(auth));
  const client = createRestGamClient({ networkCode, fetchImpl });

  process.stderr.write('1. Listing 5 most recent orders...\n');
  const orders = await client.listEntities({ entity_type: 'order' });
  process.stderr.write(`   got ${orders.length} orders; first: ${JSON.stringify(orders[0])}\n`);

  process.stderr.write('2. Running tiny report (yesterday, top advertisers, impressions)...\n');
  await tinyReport(client, tz);

  process.stderr.write('3. By-id lookups (line_item / ad_unit / placement — these used to 400)...\n');
  await byIdLookups(client);

  process.stderr.write('4. describe_line_item on live line items...\n');
  await describeSome(client, tz, networkCode);

  // Opt-in: GAM_SMOKE_SCAN=<n> walks up to n line items looking for a negated
  // custom-targeting clause, the one branch a single line item rarely covers.
  const scan = Number(process.env.GAM_SMOKE_SCAN ?? 0);
  if (scan > 0) {
    process.stderr.write(`5. Scanning up to ${scan} line items for a negated clause...\n`);
    await scanForNegation(client, tz, scan);
  }

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

// Which line items to describe. Default is whatever the network lists first,
// which may well have no custom targeting — point the run at a known order or
// at explicit ids to exercise the clause flattener.
//   GAM_SMOKE_LINE_ITEM_IDS=111,222   describe exactly these
//   GAM_SMOKE_ORDER_ID=333            describe line items under this order
async function pickLineItemIds(client: GAMClient, networkCode: string): Promise<number[]> {
  const explicit = process.env.GAM_SMOKE_LINE_ITEM_IDS;
  if (explicit) {
    const ids = explicit.split(',').map((v) => Number(v.trim())).filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length === 0) throw new Error(`GAM_SMOKE_LINE_ITEM_IDS has no valid ids: ${explicit}`);
    process.stderr.write(`   using ${ids.length} explicit line item id(s)\n`);
    return ids;
  }
  const orderId = process.env.GAM_SMOKE_ORDER_ID;
  if (orderId) {
    // Line items are a flat collection, not nested under orders, and
    // listEntities only filters on displayName. Measured 2026-08-14:
    // `filter=orderId=<n>` returns 400 "Field orderId is not supported for
    // filtering" — the same PARSE_ERROR_UNPARSABLE family as lineItemId. Try
    // the two remaining shapes and report which, if either, GAM accepts.
    const attempts: Array<[string, string]> = [
      ['filter on the order resource name',
        `lineItems?pageSize=10&filter=${encodeURIComponent(`order="networks/${networkCode}/orders/${orderId}"`)}`],
      ['nested orders/{id}/lineItems collection', `orders/${orderId}/lineItems?pageSize=10`],
    ];
    for (const [label, path] of attempts) {
      let page: Record<string, unknown> | null = null;
      try {
        page = await client.getResource(path);
      } catch (e) {
        process.stderr.write(`   ${label}: ${gamMessage(e)}\n`);
        continue;
      }
      if (!page) {
        process.stderr.write(`   ${label}: 404, collection does not exist\n`);
        continue;
      }
      const list = (page.lineItems as Array<Record<string, unknown>> | undefined) ?? [];
      const ids = list
        .map((li) => Number(li.lineItemId ?? String(li.name ?? '').split('/').pop()))
        .filter((n) => Number.isInteger(n) && n > 0);
      process.stderr.write(`   ${label}: OK, ${ids.length} line item(s)\n`);
      if (ids.length > 0) return ids;
    }
    throw new Error(
      `no way to list line items for order ${orderId} — GAM rejects every filter shape tried. ` +
      'Read the ids off the order in the GAM UI and pass GAM_SMOKE_LINE_ITEM_IDS=... instead.',
    );
  }
  return (await client.listEntities({ entity_type: 'line_item', limit: 10 })).map((e) => e.id);
}

async function describeSome(client: GAMClient, tz: string, networkCode: string): Promise<void> {
  const ids = (await pickLineItemIds(client, networkCode)).slice(0, 10);
  if (ids.length === 0) {
    process.stderr.write('   no line items to describe, skipped\n');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'gam-smoke-'));
  try {
    const r = await describeLineItemTool.handler({ ids }, {
      client,
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: tz,
      logger: noopLogger(),
    }) as Record<string, any>;
    if ('error' in r) throw new Error(`describe_line_item: ${JSON.stringify(r.error)}`);

    const items: any[] = r.line_items;
    const clauses = items.flatMap((li) => li.custom_targeting);
    const withTargeting = items.filter((li) => li.custom_targeting.length > 0).length;
    // A label that is still a resource path means resolution missed it.
    const stillRaw = clauses
      .flatMap((c: { key: string; values: string[] }) => [c.key, ...c.values])
      .filter((v: string) => v.startsWith('networks/')).length;
    // Counts and enums only — no targeting values are printed, so a smoke log
    // is safe to paste anywhere.
    // Field names only, never values — these are schema, not publisher data.
    const unmapped = [...new Set(clauses.flatMap((c: { unrecognized_fields?: Record<string, unknown> }) =>
      Object.keys(c.unrecognized_fields ?? {})))];
    process.stderr.write(
      `   described=${items.length} with_custom_targeting=${withTargeting} clauses=${clauses.length}` +
      ` negated=${clauses.filter((c: { op: string }) => c.op === 'IS NONE OF').length}` +
      ` referenced=${r.resolution.referenced} resolved=${r.resolution.resolved}` +
      ` missing=${r.resolution.missing} failed=${r.resolution.failed} unresolved_labels=${stillRaw}` +
      (unmapped.length ? ` unmapped_literal_fields=${unmapped.join(',')}` : '') + '\n',
    );
    if (r.resolution.failed > 0) {
      throw new Error(
        `${r.resolution.failed} of ${r.resolution.referenced} targeting path(s) failed to fetch — ` +
        'labels are unknown, not absent',
      );
    }
    if (stillRaw > r.resolution.missing) {
      throw new Error(`${stillRaw} targeting label(s) stayed as raw resource paths`);
    }
    if (clauses.length === 0) {
      process.stderr.write(
        '   WARNING: none of these line items use custom targeting, so clause flattening was not exercised.\n' +
        '   Re-run against a network segment that has key-value targeting to cover it.\n',
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Describe line items in small batches until a negated clause turns up. Stops
// at the first hit: the point is to confirm the IS NONE OF branch against real
// data, not to inventory the network.
async function scanForNegation(client: GAMClient, tz: string, max: number): Promise<void> {
  const all = await client.listEntities({ entity_type: 'line_item', limit: max });
  const dir = mkdtempSync(join(tmpdir(), 'gam-scan-'));
  let described = 0;
  let clausesSeen = 0;
  try {
    for (let i = 0; i < all.length; i += 25) {
      const batch = all.slice(i, i + 25).map((e) => e.id);
      const r = await describeLineItemTool.handler({ ids: batch }, {
        client,
        output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
        timezone: tz,
        logger: noopLogger(),
      }) as Record<string, any>;
      if ('error' in r) throw new Error(`describe_line_item: ${JSON.stringify(r.error)}`);
      described += r.line_items.length;
      for (const li of r.line_items as any[]) {
        clausesSeen += li.custom_targeting.length;
        const negated = li.custom_targeting.filter((c: { op: string }) => c.op === 'IS NONE OF');
        const unmapped = [...new Set(li.custom_targeting.flatMap(
          (c: { unrecognized_fields?: Record<string, unknown> }) => Object.keys(c.unrecognized_fields ?? {})))];
        if (negated.length > 0) {
          process.stderr.write(
            `   line item ${li.id}: ${negated.length} negated clause(s) — IS NONE OF confirmed against live data\n`,
          );
          return;
        }
        if (unmapped.length > 0) {
          process.stderr.write(
            `   line item ${li.id}: unmapped literal field(s) ${unmapped.join(',')} — negation may live here\n`,
          );
          return;
        }
      }
      process.stderr.write(`   ${described}/${all.length} scanned, ${clausesSeen} clause(s), none negated yet\n`);
    }
    process.stderr.write(
      `   no negated clause in ${described} line item(s) (${clausesSeen} clauses). ` +
      'IS NONE OF stays unconfirmed; try a line item known to exclude a key-value.\n',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gamMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const body = raw.slice(raw.indexOf('{'));
  try {
    return `${raw.slice(0, raw.indexOf(':'))}: ${JSON.parse(body).error.message}`;
  } catch {
    return raw.split('\n')[0];
  }
}

main().catch((e) => { process.stderr.write(`smoke: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
