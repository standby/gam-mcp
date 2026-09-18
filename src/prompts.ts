// MCP `prompts` capability: preset workflows the user can invoke from their
// client UI. Each prompt expands into a single user-role message that tells
// the LLM exactly which tools to call and in what order — analysts don't
// have to remember the right sequence of compare_periods + find_anomalies +
// top_advertisers calls.

export type PromptArgDef = {
  name: string;
  description: string;
  required: boolean;
};

export type PromptDef = {
  name: string;
  description: string;
  arguments: PromptArgDef[];
  render: (args: Record<string, string>) => string;
};

export const PROMPTS: PromptDef[] = [
  {
    name: 'weekly_pacing_review',
    description: 'Walk through pacing, fill-rate, eCPM, and viewability anomalies for the past week. Surfaces at-risk line items and inventory.',
    arguments: [
      { name: 'top_n', description: 'Max anomaly rows per category (default 20).', required: false },
    ],
    render: (args) => {
      const topN = args.top_n ?? '20';
      return [
        'Run the weekly pacing review:',
        `1. Call find_anomalies({kind:"pacing_underdelivery", top_n:${topN}}) and surface LIFETIME-goal line items GAM's delivery indicator flags as under-delivering over the last 7 days.`,
        `2. Call find_anomalies({kind:"fill_rate_drops", top_n:${topN}}) to find ad units losing fill week-over-week.`,
        `3. Call find_anomalies({kind:"ecpm_regression", top_n:${topN}}) to find demand sources whose AdX eCPM dropped.`,
        `4. Call find_anomalies({kind:"viewability_drops", top_n:${topN}}) for viewability regressions.`,
        '5. Group the findings by severity and write a short summary that names the top 3 items to fix this week.',
      ].join('\n');
    },
  },
  {
    name: 'monthly_revenue_close',
    description: 'Close-of-month revenue analysis: total, mix, top advertisers, YoY comparison.',
    arguments: [
      { name: 'month', description: 'Month to close in YYYY-MM format. Defaults to last full month.', required: false },
    ],
    render: (args) => {
      const explicitMonth = args.month?.match(/^\d{4}-\d{2}$/) ? args.month : null;
      const dateRangeBlock = explicitMonth
        ? `the explicit date range covering ${explicitMonth} (start: ${explicitMonth}-01, end: last day of ${explicitMonth})`
        : '{relative:"last_full_month"}';
      return [
        `Close the books for ${explicitMonth ?? 'the last full month'}:`,
        `1. Run revenue_summary with date_range = ${dateRangeBlock}, group_by="line_item_type" — establish total + demand mix.`,
        `2. Run top_advertisers with the same range, top_n=10, metric="revenue" — name the names that drove the month.`,
        `3. Run compare_periods on the same range with comparison="previous_year", dimensions=["LINE_ITEM_TYPE"], metrics=["REVENUE"] — flag YoY swings by demand channel.`,
        `4. Run inventory_breakdown with group_by="advertiser" for the same range — share-of-revenue concentration.`,
        '5. Write a one-paragraph executive summary: total revenue, MoM and YoY direction, mix shifts, and any concentrating risk in the top 10.',
      ].join('\n');
    },
  },
  {
    name: 'fill_rate_postmortem',
    description: 'Investigate a fill-rate drop: enumerate affected ad units, quantify lost revenue, identify likely cause.',
    arguments: [
      { name: 'lookback_days', description: 'Lookback window in days (default 14). Compares to the period immediately before.', required: false },
      { name: 'ad_unit_query', description: 'Optional substring to scope to a subset of ad units (matches AD_UNIT_NAME).', required: false },
    ],
    render: (args) => {
      const lookback = args.lookback_days ?? '14';
      const scope = args.ad_unit_query
        ? ` Restrict the analysis to ad units matching ${JSON.stringify(args.ad_unit_query)} (call lookup first, then filter run_report).`
        : '';
      return [
        `Investigate fill-rate drops over the last ${lookback} days.${scope}`,
        `1. Call find_anomalies({kind:"fill_rate_drops", top_n:30}) — get the worst-affected ad units.`,
        `2. For the top 5, call fill_rate with group_by="day" over the same window to see when the drop started.`,
        `3. Call compare_periods on dimensions=["AD_UNIT_NAME"], metrics=["AD_REQUESTS","UNFILLED_IMPRESSIONS","REVENUE"], base_range covering the last ${lookback} days, comparison="previous_period" — quantify request volume change and lost revenue.`,
        `4. If unfilled impressions are the main driver, check AD_EXCHANGE_MATCH_RATE and AD_EXCHANGE_TOTAL_REQUESTS for those ad units to see whether AdX demand collapsed.`,
        '5. Summarize: which ad units regressed, when the drop started, the revenue and request-volume change from step 3, and the most likely cause (demand collapse vs. tag misconfiguration vs. seasonal traffic).',
      ].join('\n');
    },
  },
];

export function renderPrompt(name: string, args: Record<string, string>): { description: string; text: string } | null {
  const prompt = PROMPTS.find((p) => p.name === name);
  if (!prompt) return null;
  return { description: prompt.description, text: prompt.render(args) };
}
