import type { GAMClient } from './gam-client.js';

// Session-scoped counters. Process lifetime, no persistence. Reset implicitly
// when the MCP server restarts.
export type UsageCounters = {
  started_at: string;
  list_entities_calls: number;
  get_resource_calls: number;
  report_jobs_created: number;
  poll_operations: number;
  report_cache_hits: number;
  report_cache_misses: number;
  cumulative_report_latency_ms: number;
  report_definitions_created: number;
  report_pages_fetched: number;
  report_lookups: number;
};

export function createUsageCounters(): UsageCounters {
  return {
    started_at: new Date().toISOString(),
    list_entities_calls: 0,
    get_resource_calls: 0,
    report_jobs_created: 0,
    poll_operations: 0,
    report_cache_hits: 0,
    report_cache_misses: 0,
    cumulative_report_latency_ms: 0,
    report_definitions_created: 0,
    report_pages_fetched: 0,
    report_lookups: 0,
  };
}

// Wrap a GAMClient so every method call ticks the relevant counter. The wrap
// is transparent — same interface, same return shapes. Report latency is
// measured around pollOperation/runReport/fetchRows since that's the
// quota-burning operation the LLM should be aware of.
export function instrumentGamClient(client: GAMClient, counters: UsageCounters): GAMClient {
  return {
    async listEntities(args) {
      counters.list_entities_calls += 1;
      return client.listEntities(args);
    },
    async getResource(path) {
      counters.get_resource_calls += 1;
      return client.getResource(path);
    },
    async pollOperation(name) {
      counters.poll_operations += 1;
      const start = Date.now();
      try {
        return await client.pollOperation(name);
      } finally {
        counters.cumulative_report_latency_ms += Date.now() - start;
      }
    },
    async defineReport(query, dateRange) {
      counters.report_definitions_created += 1;
      return client.defineReport(query, dateRange);
    },
    async runReport(report) {
      counters.report_jobs_created += 1;
      const start = Date.now();
      try {
        return await client.runReport(report);
      } finally {
        counters.cumulative_report_latency_ms += Date.now() - start;
      }
    },
    async fetchRows(result, page) {
      counters.report_pages_fetched += 1;
      const start = Date.now();
      try {
        return await client.fetchRows(result, page);
      } finally {
        counters.cumulative_report_latency_ms += Date.now() - start;
      }
    },
    async getReport(report) {
      counters.report_lookups += 1;
      return client.getReport(report);
    },
  };
}
