import { z } from 'zod';
import { RELATIVE_RANGES } from './dates.js';

// Input building blocks shared by tools, so every tool that takes a range
// accepts and documents the same shape (spec §3.2).

// A YYYY-MM-DD date. Any string parses here: the date rules belong to
// resolveDateRange, so a bad date is INVALID_DATE_RANGE naming its field,
// never a schema error.
export function dateField(description: string): z.ZodString {
  return z.string().describe(description);
}

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
