import { z } from 'zod';
import { gamError } from '../errors.js';
import { rangeRuleFor, resolveDateRange } from '../dates.js';
import {
  validateCombo,
  resolveDimensionAlias,
  resolveReportType,
  SUPPORTED_REPORT_TYPES,
} from '../schema.js';
import { executeReport } from '../report-exec.js';
import { READS_GAM, type ToolDefinition } from '../report-tool-builder.js';
import type { ReportQuery } from '../gam-client.js';
import { makeKvResolver, maybeRewriteKvFilter } from '../kv-rewrite.js';
import { dateRangeInput, filterInput } from '../tool-input.js';

const inputSchema = z.object({
  dimensions: z.array(z.string()).min(1).max(10)
    .describe('1-10 dimension names from describe_schema, in the column order wanted.'),
  metrics: z.array(z.string()).min(1).max(20)
    .describe(
      '1-20 metric names from describe_schema, in the column order wanted. The metrics choose the report type; ' +
      'metrics of different report types cannot be mixed.',
    ),
  date_range: dateRangeInput(
    'The dates to report on: { start, end } or { relative }. A historical report must end by yesterday; ' +
    'a sell-through forecast must start today or later and be given as dates. Dates are judged in the date time zone (GAM_TIMEZONE).',
  ),
  filters: z.array(filterInput).optional()
    .describe('Conditions every row must meet; all of them apply.'),
  // Required when querying CUSTOM_DIMENSION_<N>_VALUE dimensions. Index N in
  // the dimension name maps to index N in this array (i.e., slot 0 = key at
  // index 0). Find IDs via lookup(entity_type='custom_targeting_key').
  custom_dimension_key_ids: z.array(z.number().int().positive()).optional()
    .describe(
      'Custom targeting key IDs for CUSTOM_DIMENSION_<N>_VALUE dimensions: the ID at index N fills slot N. ' +
      'Find them with lookup(entity_type="custom_targeting_key").',
    ),
}).strict();

export const runReportTool: ToolDefinition<typeof inputSchema> = {
  name: 'run_report',
  description:
    'Run an arbitrary GAM report. Pick dimensions and metrics from describe_schema. Date range accepts absolute {start,end} or {relative: enum}. Returns the first page of rows with provenance; when more rows exist, pass next_cursor to fetch_report_page. Asking only for reach metrics (UNIQUE_VISITORS, REACH_IMPRESSIONS, AVERAGE_IMPRESSIONS_PER_UNIQUE_VISITOR) switches GAM to its REACH report type automatically; those cannot be mixed with historical metrics in one call.',
  input: inputSchema,
  annotations: READS_GAM,
  async handler(input, ctx) {
    // Rewrite alias dimension names (e.g. CREATIVE_SIZE → RENDERED_CREATIVE_SIZE)
    // to their canonical REST names before validating, so familiar names don't
    // trip the unknown-dimension check or get rejected by GAM.
    const aliasWarnings: string[] = [];
    const dimensions = input.dimensions.map((d) => {
      const canonical = resolveDimensionAlias(d);
      if (canonical !== d) {
        aliasWarnings.push(`Dimension '${d}' is not a GAM REST dimension; queried as '${canonical}'.`);
      }
      return canonical;
    });

    const comboError = validateCombo({ dimensions, metrics: input.metrics });
    if (comboError) {
      return gamError('INVALID_INPUT', { reason: comboError, hint: 'Call describe_schema for valid names.' });
    }

    // UNIQUE_REACH* live under GAM's REACH report type, everything else under
    // HISTORICAL. Derived from the metrics so the caller never picks; a mixed
    // list is rejected here with a clearer message than GAM's 400.
    const reportType = resolveReportType(input.metrics, dimensions);
    if (typeof reportType !== 'string') {
      return gamError('INVALID_INPUT', {
        reason: reportType.error,
        hint: 'Call describe_schema({report_type: "..."}) to see what each report type accepts.',
      });
    }

    const dateRange = resolveDateRange(input.date_range, {
      timezone: ctx.timezone,
      now: ctx.now,
      rule: rangeRuleFor(reportType),
    });
    if ('error' in dateRange) return dateRange;

    let query: ReportQuery = {
      dimensions,
      metrics: input.metrics,
      filters: input.filters,
      custom_dimension_key_ids: input.custom_dimension_key_ids,
      report_type: reportType,
    };
    const warnings: string[] = [...aliasWarnings];
    // The whitelist covers every metric GAM declares, including families whose
    // report type this server has no purpose-built tool for. Those requests are
    // forwarded as-is — GAM may still reject them for reasons we can't predict.
    if (!SUPPORTED_REPORT_TYPES.includes(reportType)) {
      warnings.push(
        `These metrics resolve to GAM report type ${reportType}, which this server ` +
        `forwards but has not been verified against. If GAM rejects the request, the ` +
        `report type may need additional fields we do not send.`,
      );
    }

    // Auto-rewrite KEY_VALUES_NAME='channel_id=479' + AD_REQUESTS (and other
    // request-time metrics) → CUSTOM_DIMENSION slot, since GAM rejects the
    // raw combo. Hidden from the caller's tool call — they get the data and
    // a warning explaining what happened.
    const rewrite = await maybeRewriteKvFilter(query, makeKvResolver(ctx.client));
    if (rewrite.rewritten) {
      query = rewrite.query;
      warnings.push(rewrite.warning);
      ctx.logger.info('report.kv_rewrite', {
        tool: 'run_report',
        warning: rewrite.warning,
      });
    } else if ('error' in rewrite && rewrite.error) {
      return gamError('INVALID_INPUT', {
        reason: rewrite.error,
        hint: 'Discover the key via lookup(entity_type="custom_targeting_key", match="exact") and pass it via custom_dimension_key_ids + CUSTOM_DIMENSION_<N>_VALUE.',
      });
    }

    const summary =
      `Report: dims=[${query.dimensions.join(',')}] metrics=[${query.metrics.join(',')}] ` +
      `${dateRange.start}..${dateRange.end}`;

    return executeReport(ctx, { tool: 'run_report', query, dateRange, summary, warnings });
  },
};
