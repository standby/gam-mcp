import type { ReportDefinition } from './report-definition.js';

// Surfaced on every result. The dedup semantics are the single most common way
// to misread this report, and the frequency column is conditionally empty.
export const REACH_NON_ADDITIVE_WARNING =
  'Reach deduplicates people, so UNIQUE_VISITORS is NOT additive: summing it across rows ' +
  '(countries, days, line items) double-counts anyone reached in more than one row. ' +
  'For a total, re-run at the level you want instead of summing. ' +
  'If AVERAGE_IMPRESSIONS_PER_UNIQUE_VISITOR is blank, compute it as ' +
  'REACH_IMPRESSIONS / UNIQUE_VISITORS — GAM only populates that column when ' +
  'COUNTRY_NAME is a dimension.';

export const REACH_COVERAGE_WARNING =
  'Reach covers ad-server / reservation delivery only (excludes Ad Exchange and AdSense), ' +
  'lands ~3 days late, and is retained about 1 year.';

// Caveats that follow from a definition alone, so every page of a result
// carries them: a fresh first page, a page served from the cache, and a page
// fetched with a cursor all have the definition.
export function definitionWarnings(definition: ReportDefinition): string[] {
  return definition.reportType === 'REACH' ? [REACH_NON_ADDITIVE_WARNING, REACH_COVERAGE_WARNING] : [];
}
