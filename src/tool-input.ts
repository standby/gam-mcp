import { z } from 'zod';
import { RELATIVE_RANGES } from './dates.js';

// Input building blocks shared by tools, so every tool that takes a range
// accepts and documents the same shape (spec §3.2).

// Date fields, so the advertised schema can say `format: date` without
// zod rejecting a bad date before resolveDateRange can name it.
const DATE_FIELDS = new WeakSet<z.ZodTypeAny>();

// A YYYY-MM-DD date. Any string parses here: the date rules belong to
// resolveDateRange, so a bad date is INVALID_DATE_RANGE naming its field,
// never a schema error. Describe it here: a later .describe() makes a copy
// that is no longer marked as a date.
export function dateField(description: string): z.ZodString {
  const field = z.string().describe(description);
  DATE_FIELDS.add(field);
  return field;
}

export function isDateField(schema: z.ZodTypeAny): boolean {
  return DATE_FIELDS.has(schema);
}

// One report filter, as run_report, compare_periods and save_query take it.
// GAM has no EQUALS or NOT_EQUALS: `=` and `!=` are sent as IN and NOT_IN
// with one value (report-definition.ts).
export const filterInput = z
  .object({
    field: z.string().describe('The dimension to filter on, from describe_schema.'),
    op: z
      .enum(['=', 'IN', '!=', 'CONTAINS', 'NOT_CONTAINS'])
      .default('=')
      .describe(
        '"=" and "IN" keep rows whose value is one of `value`; "!=" drops them; ' +
        'CONTAINS and NOT_CONTAINS match part of a text value.',
      ),
    value: z
      .union([z.string(), z.number(), z.array(z.union([z.string(), z.number()])).max(500)])
      .describe('The value to compare with, or a list of values. Numbers are sent as IDs.'),
  })
  .strict()
  .describe('A condition on one dimension.');

// The usual description of a historical report's date_range.
export const HISTORICAL_RANGE =
  'The dates to report on: { start, end } or { relative }. The range must end by yesterday in the date time zone (GAM_TIMEZONE).';

// Either { start, end } or { relative }.
export function dateRangeInput(description: string) {
  return z
    .union([
      z
        .object({
          start: dateField('First day of the range, inclusive, as YYYY-MM-DD.'),
          end: dateField('Last day of the range, inclusive, as YYYY-MM-DD.'),
        })
        .strict()
        .describe('Absolute dates.'),
      z
        .object({
          relative: z
            .enum(RELATIVE_RANGES)
            .describe(
              'A range relative to today in the date time zone (GAM_TIMEZONE). Every choice ends by yesterday; ' +
              'month_to_date, quarter_to_date and year_to_date fail on the first day of their period.',
            ),
        })
        .strict()
        .describe('A relative range.'),
    ])
    .describe(description);
}

// A failed parse as one line naming where each problem is, for
// INVALID_INPUT: `date_range: unknown key "tz"`.
export function describeInputError(error: z.ZodError): string {
  return error.issues.map(describeIssue).join('; ');
}

function describeIssue(issue: z.ZodIssue): string {
  if (issue.code === 'invalid_union') {
    // Name the problems of the choice the input came closest to.
    const closest = [...issue.unionErrors].sort((a, b) => a.issues.length - b.issues.length)[0];
    if (closest) return describeInputError(closest);
  }
  const at = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  if (issue.code === 'unrecognized_keys') {
    const keys = issue.keys.map((k) => JSON.stringify(k)).join(', ');
    return `${at}unknown ${issue.keys.length === 1 ? 'key' : 'keys'} ${keys}`;
  }
  return `${at}${issue.message}`;
}
