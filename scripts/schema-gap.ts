/**
 * schema-gap.ts
 *
 * Diffs the canonical GAM REST enums (Metric, Dimension, ReportType) against
 * what src/schema.ts whitelists, and prints what we cannot currently query.
 *
 * Companion to refresh-schema.ts: that one regenerates the schema wholesale
 * (losing the curated descriptions and incompatibility matrix); this one just
 * reports the gap so entries can be added by hand with their prose intact.
 *
 * Usage:
 *   npx tsx scripts/schema-gap.ts            # summary + full missing lists
 *   npx tsx scripts/schema-gap.ts --families # counts per name prefix only
 *
 * No credentials required — reads the public proto files only.
 */
import { GAM_SCHEMA, SUPPORTED_REPORT_TYPES } from '../src/schema.js';

const BASE = 'https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/admanager/v1';
const REPORT_DEFINITION_PROTO = `${BASE}/report_definition.proto`;

async function main(): Promise<void> {
  const proto = await fetchText(REPORT_DEFINITION_PROTO);

  const metrics = extractEnum(proto, 'Metric');
  const dimensions = extractEnum(proto, 'Dimension');
  const reportTypes = extractEnum(proto, 'ReportType');

  if (!metrics.length || !dimensions.length) {
    fail('Could not extract Metric/Dimension enums — proto layout may have changed.');
  }

  report('METRIC', metrics, GAM_SCHEMA.metrics.map((m) => m.name));
  report('DIMENSION', dimensions, GAM_SCHEMA.dimensions.map((d) => d.name));
  // "Missing" here means no purpose-built tool — run_report still forwards
  // these, since every metric they use is whitelisted.
  report('REPORT_TYPE', reportTypes, [...SUPPORTED_REPORT_TYPES]);
}

function report(label: string, upstream: string[], ours: string[]): void {
  const have = new Set(ours);
  const missing = upstream.filter((n) => !have.has(n));
  const stale = ours.filter((n) => !upstream.includes(n));

  out(`\n=== ${label} — upstream ${upstream.length}, whitelisted ${ours.length}, missing ${missing.length}`);

  const byFamily = new Map<string, string[]>();
  for (const n of missing) {
    const fam = n.split('_').slice(0, 2).join('_');
    byFamily.set(fam, [...(byFamily.get(fam) ?? []), n]);
  }
  const families = [...byFamily.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [fam, names] of families) {
    out(`  ${fam.padEnd(32)} ${String(names.length).padStart(4)}`);
    if (!process.argv.includes('--families')) {
      for (const n of names) out(`      ${n}`);
    }
  }
  // A name we whitelist that upstream no longer has is a live bug: run_report
  // would accept it and GAM would 400.
  if (stale.length) out(`  !! whitelisted but NOT in upstream enum: ${stale.join(', ')}`);
}

// Extract non-UNSPECIFIED member names from a named proto enum block.
// Scans line-wise to the enum's closing brace rather than regex-matching
// `\{([^}]+)\}` — these enums carry doc comments containing `}` (e.g. in
// `{key: value}` examples), and a non-greedy match silently stops there,
// truncating the enum and reporting live names as missing.
function extractEnum(proto: string, enumName: string): string[] {
  const lines = proto.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^\\s*enum\\s+${enumName}\\s*\\{`).test(l));
  if (start === -1) return [];
  const names: string[] = [];
  // Track brace depth from the enum's own opening brace. Indentation is not a
  // reliable terminator: ReportType is nested inside a message, so its closing
  // brace is indented, and comment text contributes stray braces of its own.
  let depth = 0;
  for (const line of lines.slice(start)) {
    const code = line.replace(/\/\/.*$/, ''); // strip trailing comment
    for (const ch of code) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    const m = code.match(/^\s*([A-Z][A-Z0-9_]+)\s*=\s*\d+\s*;/);
    if (m && !m[1].endsWith('_UNSPECIFIED')) names.push(m[1]);
    if (depth === 0 && names.length) break;
  }
  return names;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) fail(`fetch ${url}: ${res.status} ${res.statusText}`);
  return res.text();
}

function out(s: string): void { process.stdout.write(`${s}\n`); }
function fail(msg: string): never {
  process.stderr.write(`schema-gap: ${msg}\n`);
  process.exit(1);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
