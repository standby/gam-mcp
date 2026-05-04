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
] as unknown as ToolDefinition<ZodTypeAny>[];
