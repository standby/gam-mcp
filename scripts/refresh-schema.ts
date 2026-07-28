/**
 * refresh-schema.ts
 *
 * Regenerates src/schema-generated.ts from the canonical GAM REST enums in
 * report_definition.proto.
 *
 * The proto carries everything a schema entry needs — a description, the UI
 * label, the compatible report types, and a data format that maps onto our
 * `type` field — so this is a parse, not a judgment call. Hand-curated prose
 * and the incompatibility matrix live separately in src/schema-overrides.ts
 * and are merged over the generated entries by src/schema.ts, so re-running
 * this never clobbers them.
 *
 * Usage:
 *   npm run refresh-schema           # writes src/schema-generated.ts
 *   npx tsx scripts/refresh-schema.ts --stdout
 *
 * Verify afterwards with: npx tsx scripts/schema-gap.ts
 * No credentials required — reads the public proto only.
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTO_URL =
  'https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/admanager/v1/report_definition.proto';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'schema-generated.ts');

type Entry = { name: string; type: string; description: string; report_types: string[] };

async function main(): Promise<void> {
  process.stderr.write(`Fetching ${PROTO_URL}\n`);
  const res = await fetch(PROTO_URL);
  if (!res.ok) fail(`fetch: ${res.status} ${res.statusText}`);
  const proto = await res.text();

  const metrics = parseMembers(proto, 'Metric').map((m) => toEntry(m, 'metric'));
  const dimensions = parseMembers(proto, 'Dimension').map((m) => toEntry(m, 'dimension'));
  const reportTypes = parseMembers(proto, 'ReportType').map((m) => m.name);

  if (metrics.length < 400 || dimensions.length < 400 || reportTypes.length < 5) {
    fail(`suspiciously small parse (metrics=${metrics.length} dimensions=${dimensions.length} ` +
         `reportTypes=${reportTypes.length}) — proto layout may have changed`);
  }

  const source = emit(dimensions, metrics, reportTypes);
  if (process.argv.includes('--stdout')) process.stdout.write(source);
  else writeFileSync(OUT, source);

  process.stderr.write(
    `Wrote ${dimensions.length} dimensions, ${metrics.length} metrics, ` +
    `${reportTypes.length} report types${process.argv.includes('--stdout') ? ' (stdout)' : ` -> ${OUT}`}\n`,
  );
}

type Member = { name: string; doc: string };

/**
 * Pull `NAME = n;` members plus their leading `//` doc block out of a named
 * proto enum. Brace-depth counted from the enum's own `{`: these enums are
 * nested (ReportType sits inside a message) and their doc comments contain
 * literal braces, so neither indentation nor a `\{([^}]+)\}` regex terminates
 * the block correctly — a non-greedy match silently truncates the enum.
 */
function parseMembers(proto: string, enumName: string): Member[] {
  const lines = proto.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^\\s*enum\\s+${enumName}\\s*\\{`).test(l));
  if (start === -1) fail(`enum ${enumName} not found`);

  const members: Member[] = [];
  let depth = 0;
  let doc: string[] = [];
  for (const line of lines.slice(start)) {
    const code = line.replace(/\/\/.*$/, '');
    for (const ch of code) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) {
      doc.push(trimmed.replace(/^\/\/\s*/, ''));
    } else {
      const m = code.match(/^\s*([A-Z][A-Z0-9_]+)\s*=\s*\d+\s*;/);
      if (m && !m[1].endsWith('_UNSPECIFIED')) members.push({ name: m[1], doc: doc.join(' ') });
      if (m || trimmed === '') doc = [];
    }
    if (depth === 0 && members.length) break;
  }
  return members;
}

function toEntry(m: Member, kind: 'metric' | 'dimension'): Entry {
  const doc = m.doc.replace(/\s+/g, ' ').trim();
  const report_types = [...doc.matchAll(/`([A-Z][A-Z0-9_]+)`/g)]
    .map((x) => x[1])
    .filter((x) => /^[A-Z_]+$/.test(x));
  const compat = doc.match(/Compatible with the following report types:\s*(.+?)(?:\s*Data format:|$)/);
  const types = compat
    ? [...compat[1].matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((x) => x[1])
    : [];
  const format = doc.match(/Data format:\s*`(\w+)`/)?.[1];

  // Keep the prose and the "Corresponds to X in the Ad Manager UI" label —
  // that label is how a user's wording maps onto an enum name. Drop the
  // compatibility and data-format sentences, which become structured fields.
  const description = doc
    .replace(/Compatible with the following report types:.*?(?=Data format:|$)/, '')
    .replace(/Data format:\s*`\w+`\.?/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    name: m.name,
    type: kind === 'metric' ? metricType(format) : dimensionType(m.name, format),
    description: description || `${m.name} ${kind}.`,
    report_types: types.length ? types : report_types.filter((t) => t !== format),
  };
}

// Data format is authoritative — more reliable than guessing from the name,
// which mislabels e.g. AD_EXCHANGE_COST_PER_CLICK (MONEY) vs *_RATE (PERCENT).
function metricType(format?: string): 'number' | 'currency' | 'rate' {
  if (format === 'MONEY') return 'currency';
  if (format === 'PERCENT' || format === 'WHOLE_PERCENT') return 'rate';
  return 'number';
}

function dimensionType(name: string, format?: string): 'string' | 'number' | 'date' {
  if (format === 'DATE' || format === 'TIMESTAMP' || format === 'DATE_RANGE') return 'date';
  if (format === 'IDENTIFIER' || format === 'IDENTIFIER_LIST' || format === 'INTEGER') return 'number';
  if (format) return 'string';
  // ~240 dimensions carry no data format; fall back to the name.
  if (/\b(DATE|WEEK|MONTH|HOUR)\b/.test(name)) return 'date';
  if (/_ID$|_IDS$/.test(name)) return 'number';
  return 'string';
}

function emit(dims: Entry[], metrics: Entry[], reportTypes: string[]): string {
  const rows = (es: Entry[]) =>
    es.map((e) =>
      `  { name: ${JSON.stringify(e.name)}, type: ${JSON.stringify(e.type)}, ` +
      `report_types: ${JSON.stringify(e.report_types)}, description: ${JSON.stringify(e.description)} },`,
    ).join('\n');

  return [
    `// AUTO-GENERATED by scripts/refresh-schema.ts — do not edit by hand.`,
    `// Source: ${PROTO_URL}`,
    `// Curated descriptions and the incompatibility matrix live in`,
    `// schema-overrides.ts and are merged over these entries by schema.ts.`,
    ``,
    `export type GeneratedEntry = {`,
    `  name: string;`,
    `  type: string;`,
    `  /** GAM report types this entry can be queried under. */`,
    `  report_types: string[];`,
    `  description: string;`,
    `};`,
    ``,
    `export const REPORT_TYPES = ${JSON.stringify(reportTypes)} as const;`,
    ``,
    `export const GENERATED_DIMENSIONS: GeneratedEntry[] = [`,
    rows(dims),
    `];`,
    ``,
    `export const GENERATED_METRICS: GeneratedEntry[] = [`,
    rows(metrics),
    `];`,
    ``,
  ].join('\n');
}

function fail(msg: string): never {
  process.stderr.write(`refresh-schema: ${msg}\n`);
  process.exit(1);
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
