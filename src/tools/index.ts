import { lookupTool } from './lookup.js';
import { describeSchemaTool } from './describe_schema.js';
import { describeLineItemTool } from './describe_line_item.js';
import { runReportTool } from './run_report.js';
import { fetchReportPageTool } from './fetch_report_page.js';
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
import { reachReportTool } from './reach_report.js';
import { adSpeedTool } from './ad_speed.js';
import { sellThroughTool } from './sell_through.js';
import { consentMessagingTool } from './consent_messaging.js';
import { findUnusedAdUnitsTool } from './find_unused_ad_units.js';
import { diagnoseFillRateTool } from './diagnose_fill_rate.js';
import { diagnoseFloorPricingTool } from './diagnose_floor_pricing.js';
import { healthCheckTool } from './health_check.js';
import { usageStatsTool } from './usage_stats.js';
import {
  saveQueryTool,
  listSavedQueriesTool,
  runSavedQueryTool,
  deleteSavedQueryTool,
} from './saved_queries.js';
import type { ToolDefinition } from '../report-tool-builder.js';

export type TransportMode = 'stdio' | 'http';

// Tools every transport serves.
const SHARED_TOOLS: ToolDefinition[] = [
  lookupTool,
  describeSchemaTool,
  describeLineItemTool,
  runReportTool,
  fetchReportPageTool,
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
  reachReportTool,
  adSpeedTool,
  sellThroughTool,
  consentMessagingTool,
  findUnusedAdUnitsTool,
  diagnoseFillRateTool,
  diagnoseFloorPricingTool,
  healthCheckTool,
  usageStatsTool,
];

// Saved queries live in a file on the machine the server runs on and are
// shared by everyone it serves, so only stdio offers them (spec D-3, §3.5).
const STDIO_ONLY_TOOLS: ToolDefinition[] = [
  saveQueryTool,
  listSavedQueriesTool,
  runSavedQueryTool,
  deleteSavedQueryTool,
];

export function toolsFor(mode: TransportMode): ToolDefinition[] {
  return mode === 'stdio' ? [...SHARED_TOOLS, ...STDIO_ONLY_TOOLS] : [...SHARED_TOOLS];
}

// Every tool this server has: the stdio set.
export const ALL_TOOLS: ToolDefinition[] = toolsFor('stdio');
