import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ALL_TOOLS } from '../src/tools/index.js';
import { GENERATED_DIMENSIONS, GENERATED_METRICS, type GeneratedEntry } from '../src/schema-generated.js';
import { executeReport, executeReportRows } from '../src/report-exec.js';
import type { ReportDefinition } from '../src/report-definition.js';
import type { ToolDefinition } from '../src/report-tool-builder.js';
import { argsFor, NO_REPORT, toolWorld } from './tool-table.js';
import { counted } from './helpers.js';

const DIMENSIONS = new Map(GENERATED_DIMENSIONS.map((e) => [e.name, e]));
const METRICS = new Map(GENERATED_METRICS.map((e) => [e.name, e]));

// Every choice of an enum field (and leaving an optional one out).
function choicesOf(field: z.ZodTypeAny): unknown[] | null {
  let inner = field;
  let optional = false;
  for (;;) {
    if (inner instanceof z.ZodOptional) { optional = true; inner = inner.unwrap(); }
    else if (inner instanceof z.ZodDefault) inner = inner._def.innerType;
    else break;
  }
  if (!(inner instanceof z.ZodEnum)) return null;
  return optional ? [...inner.options, undefined] : [...inner.options];
}

// The tool's row from the table, crossed with every combination of its
// enum fields: together these reach every name the tool can request.
function variants(tool: ToolDefinition<z.ZodTypeAny>): Record<string, unknown>[] {
  let out = [argsFor(tool.name)];
  for (const [key, field] of Object.entries((tool.input as z.AnyZodObject).shape)) {
    const choices = choicesOf(field as z.ZodTypeAny);
    if (!choices) continue;
    out = out.flatMap((args) => choices.map((choice) => {
      const next = { ...args };
      if (choice === undefined) delete next[key];
      else next[key] = choice;
      return next;
    }));
  }
  return out;
}

function offered(entry: GeneratedEntry | undefined, reportType: string): boolean {
  // An entry listed without report types (a publisher-configured slot) is
  // not restricted.
  return entry !== undefined && (entry.report_types.length === 0 || entry.report_types.includes(reportType));
}

function filterFields(definition: ReportDefinition): string[] {
  return (definition.filters ?? []).map((f) => (f as { fieldFilter: { field: { dimension: string } } }).fieldFilter.field.dimension);
}

describe('H3: every name a tool can request exists for its report type', () => {
  it.each(ALL_TOOLS.map((t) => [t.name, t] as const))('%s', async (name, tool) => {
    const seen: ReportDefinition[] = [];
    for (const args of variants(tool)) {
      const ctx = toolWorld();
      const inner = ctx.client;
      ctx.client = { ...inner, defineReport: (d) => { seen.push(d); return inner.defineReport(d); } };
      const r = await tool.handler(tool.input.parse(args), ctx);
      // A report tool must get as far as GAM with every variant.
      if (!NO_REPORT.has(name)) expect(r, `${name} ${JSON.stringify(args)}`).not.toHaveProperty('error');
    }
    if (NO_REPORT.has(name)) {
      expect(seen).toEqual([]);
      return;
    }
    expect(seen.length, `${name} built no report`).toBeGreaterThan(0);
    for (const d of seen) {
      for (const dim of [...d.dimensions, ...filterFields(d)]) {
        expect(offered(DIMENSIONS.get(dim), d.reportType), `${name}: dimension ${dim} in ${d.reportType}`).toBe(true);
      }
      for (const metric of d.metrics) {
        expect(offered(METRICS.get(metric), d.reportType), `${name}: metric ${metric} in ${d.reportType}`).toBe(true);
      }
    }
  });
});

describe('the report path checks every query before GAM sees it (spec §2.1 step 1)', () => {
  const range = { start: '2026-09-01', end: '2026-09-07' };
  const cases = [
    [{ dimensions: ['AD_UNIT_ID'], metrics: ['TOTAL_LINE_ITEM_LEVEL_REVENUE'] }, 'Unknown metric: TOTAL_LINE_ITEM_LEVEL_REVENUE'],
    [{ dimensions: ['NOT_A_DIMENSION'], metrics: ['IMPRESSIONS'] }, 'Unknown dimension: NOT_A_DIMENSION'],
    [{ dimensions: ['AD_UNIT_ID'], metrics: ['UNIQUE_VISITORS'] }, 'UNIQUE_VISITORS is not offered in HISTORICAL reports'],
    [
      { dimensions: ['AD_UNIT_ID'], metrics: ['IMPRESSIONS'], filters: [{ field: 'NOT_A_DIMENSION', op: '=' as const, value: 1 }] },
      'Unknown filter dimension: NOT_A_DIMENSION',
    ],
  ] as const;

  it.each(cases)('%j', async (query, reason) => {
    const { ctx, counters } = counted({});
    for (const r of [
      await executeReport(ctx, { tool: 't', query: structuredClone(query) as never, dateRange: range, summary: 'S' }),
      await executeReportRows(ctx, structuredClone(query) as never, range, 't'),
    ]) {
      expect(r).toMatchObject({ error: { code: 'INVALID_INPUT', details: { reason } } });
    }
    expect(counters.report_definitions_created).toBe(0);
  });
});
