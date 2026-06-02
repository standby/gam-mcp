import { lookupTool } from './lookup.js';
import { describeSchemaTool } from './describe_schema.js';
import { runReportTool } from './run_report.js';
import { revenueSummaryTool } from './revenue_summary.js';
import { topAdvertisersTool } from './top_advertisers.js';
import { topLineItemsTool } from './top_line_items.js';
import { pacingStatusTool } from './pacing_status.js';
import { fillRateTool } from './fill_rate.js';
import { inventoryBreakdownTool } from './inventory_breakdown.js';
import { revenueTrendTool } from './revenue_trend.js';
import { comparePeriodsTool } from './compare_periods.js';
import { findAnomaliesTool } from './find_anomalies.js';
import { kvBreakdownTool } from './kv_breakdown.js';
import { kvReportTool } from './kv_report.js';
import { bidderBreakdownTool } from './bidder_breakdown.js';
import { yieldBreakdownTool } from './yield_breakdown.js';
import { videoBreakdownTool } from './video_breakdown.js';
import { viewabilityBreakdownTool } from './viewability_breakdown.js';
import { findUnusedAdUnitsTool } from './find_unused_ad_units.js';
import { diagnoseFillRateTool } from './diagnose_fill_rate.js';
import { healthCheckTool } from './health_check.js';
import { usageStatsTool } from './usage_stats.js';
import {
  saveQueryTool,
  listSavedQueriesTool,
  runSavedQueryTool,
  deleteSavedQueryTool,
} from './saved_queries.js';
import type { ToolDefinition } from '../report-tool-builder.js';
import type { ZodTypeAny } from 'zod';

export const ALL_TOOLS: ToolDefinition<ZodTypeAny>[] = [
  lookupTool,
  describeSchemaTool,
  runReportTool,
  revenueSummaryTool,
  topAdvertisersTool,
  topLineItemsTool,
  pacingStatusTool,
  fillRateTool,
  inventoryBreakdownTool,
  revenueTrendTool,
  comparePeriodsTool,
  findAnomaliesTool,
  kvBreakdownTool,
  kvReportTool,
  bidderBreakdownTool,
  yieldBreakdownTool,
  videoBreakdownTool,
  viewabilityBreakdownTool,
  findUnusedAdUnitsTool,
  diagnoseFillRateTool,
  healthCheckTool,
  usageStatsTool,
  saveQueryTool,
  listSavedQueriesTool,
  runSavedQueryTool,
  deleteSavedQueryTool,
] as unknown as ToolDefinition<ZodTypeAny>[];
