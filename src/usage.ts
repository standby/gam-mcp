import type { GAMClient } from './gam-client.js';

// Session-scoped counters. Process lifetime, no persistence. Reset implicitly
// when the MCP server restarts.
export type UsageCounters = {
  started_at: string;
  list_entities_calls: number;
  report_jobs_created: number;
  poll_operations: number;
  reports_downloaded: number;
  report_cache_hits: number;
  report_cache_misses: number;
  cumulative_report_latency_ms: number;
};

export function createUsageCounters(): UsageCounters {
  return {
    started_at: new Date().toISOString(),
    list_entities_calls: 0,
    report_jobs_created: 0,
    poll_operations: 0,
    reports_downloaded: 0,
    report_cache_hits: 0,
    report_cache_misses: 0,
    cumulative_report_latency_ms: 0,
  };
}

// Wrap a GAMClient so every method call ticks the relevant counter. The wrap
// is transparent — same interface, same return shapes. Report latency is
// measured around createReport→pollOperation→download since that's the
// quota-burning operation the LLM should be aware of.
export function instrumentGamClient(client: GAMClient, counters: UsageCounters): GAMClient {
  return {
    async listEntities(args) {
      counters.list_entities_calls += 1;
      return client.listEntities(args);
    },
    async createReport(query, dateRange) {
      counters.report_jobs_created += 1;
      const start = Date.now();
      try {
        return await client.createReport(query, dateRange);
      } finally {
        counters.cumulative_report_latency_ms += Date.now() - start;
      }
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
    async downloadReport(downloadUrl, destPath) {
      counters.reports_downloaded += 1;
      const start = Date.now();
      try {
        return await client.downloadReport(downloadUrl, destPath);
      } finally {
        counters.cumulative_report_latency_ms += Date.now() - start;
      }
    },
  };
}
