import { z } from 'zod';
import { gamError } from '../errors.js';
import type { ToolDefinition, ToolContext } from '../report-tool-builder.js';

const inputSchema = z.object({});

export const usageStatsTool: ToolDefinition<typeof inputSchema> = {
  name: 'usage_stats',
  description:
    'Session-to-date counters for this MCP server: number of GAM API calls by type, report-job count, cumulative report latency, and cache effectiveness. ' +
    'Useful for the LLM to self-pace ("you have run 12 reports this session") and for the analyst to spot redundant work via the cache-hit ratio.',
  input: inputSchema,
  async handler(_input, ctx: ToolContext) {
    const counters = ctx.usageCounters;
    if (!counters) {
      return gamError('INTERNAL_ERROR', { reason: 'usage counters are not configured' });
    }
    const cache = ctx.reportCache?.stats() ?? { hits: 0, misses: 0 };
    const totalLookups = cache.hits + cache.misses;
    const hitRatePct = totalLookups === 0 ? '—' : ((cache.hits / totalLookups) * 100).toFixed(1);

    const row = {
      session_started_at: counters.started_at,
      list_entities_calls: String(counters.list_entities_calls),
      get_resource_calls: String(counters.get_resource_calls),
      report_jobs_created: String(counters.report_jobs_created),
      poll_operations: String(counters.poll_operations),
      reports_downloaded: String(counters.reports_downloaded),
      cumulative_report_latency_ms: String(counters.cumulative_report_latency_ms),
      report_cache_hits: String(cache.hits),
      report_cache_misses: String(cache.misses),
      report_cache_hit_rate_pct: hitRatePct,
    };
    return ctx.output.fromInlineRows(
      [row],
      `Usage since ${counters.started_at}: ${counters.report_jobs_created} report jobs, ${cache.hits} cache hits / ${cache.misses} misses (${hitRatePct}% hit rate).`,
    );
  },
};
