import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toJsonSchema } from '../src/json-schema.js';
import { dateField, dateRangeInput, describeInputError } from '../src/tool-input.js';
import { ALL_TOOLS } from '../src/tools/index.js';

describe('toJsonSchema (spec §3.1)', () => {
  it('advertises descriptions, defaults, bounds, patterns, enums, dates and strictness', () => {
    const schema = z.object({
      name: z.string().min(1).max(64).regex(/^[a-z]+$/).describe('A name.'),
      top_n: z.number().int().min(1).max(500).default(50).describe('How many rows.'),
      ratio: z.number().positive().lt(1).optional().describe('A share.'),
      kind: z.enum(['a', 'b']).default('a').describe('Which kind.'),
      ids: z.array(z.number().int().positive()).min(1).max(50).optional().describe('Some IDs.'),
      day: dateField('A day.'),
      flag: z.boolean().optional().describe('A switch.'),
      pick: z.union([z.literal('x'), z.object({ y: z.string().describe('Y.') }).strict()]).describe('One or the other.'),
    }).strict();

    expect(toJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        name: { description: 'A name.', type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z]+$' },
        top_n: { description: 'How many rows.', type: 'integer', minimum: 1, maximum: 500, default: 50 },
        ratio: { description: 'A share.', type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
        kind: { description: 'Which kind.', type: 'string', enum: ['a', 'b'], default: 'a' },
        ids: {
          description: 'Some IDs.',
          type: 'array',
          items: { type: 'integer', exclusiveMinimum: 0 },
          minItems: 1,
          maxItems: 50,
        },
        day: { description: 'A day.', type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        flag: { description: 'A switch.', type: 'boolean' },
        pick: {
          description: 'One or the other.',
          anyOf: [
            { const: 'x' },
            { type: 'object', properties: { y: { description: 'Y.', type: 'string' } }, required: ['y'], additionalProperties: false },
          ],
        },
      },
      required: ['name', 'day', 'pick'],
      additionalProperties: false,
    });
  });

  it('leaves additionalProperties out for an object that is not strict', () => {
    expect(toJsonSchema(z.object({}))).toEqual({ type: 'object', properties: {} });
  });

  it('keeps a description given after optional() or default()', () => {
    expect(toJsonSchema(z.string().optional().describe('Later.'))).toEqual({ description: 'Later.', type: 'string' });
    expect(toJsonSchema(z.number().default(3).describe('Later.'))).toEqual({ description: 'Later.', type: 'number', default: 3 });
  });

  it('refuses a zod type it cannot describe', () => {
    expect(() => toJsonSchema(z.object({ when: z.date() }))).toThrow('no JSON Schema for zod type ZodDate');
    expect(() => toJsonSchema(z.string().email())).toThrow('no JSON Schema for string check email');
  });

  it('describes every registered tool input', () => {
    for (const tool of ALL_TOOLS) {
      expect(() => toJsonSchema(tool.input), tool.name).not.toThrow();
      expect(toJsonSchema(tool.input)).toMatchObject({ type: 'object' });
    }
  });
});

describe('describeInputError', () => {
  const input = z.object({ date_range: dateRangeInput('Dates.'), top_n: z.number() }).strict();
  const reason = (value: unknown) => {
    const parsed = input.safeParse(value);
    if (parsed.success) throw new Error('expected a parse failure');
    return describeInputError(parsed.error);
  };
  const range = { start: '2026-09-01', end: '2026-09-02' };

  it('names an unknown top-level key', () => {
    expect(reason({ date_range: range, top_n: 1, filter: [] })).toBe('unknown key "filter"');
  });

  it('names an unknown key inside a range, from the choice the input came closest to', () => {
    expect(reason({ date_range: { ...range, tz: 'UTC' }, top_n: 1 })).toBe('date_range: unknown key "tz"');
  });

  it('names a relative range that does not exist', () => {
    expect(reason({ date_range: { relative: 'today' }, top_n: 1 })).toMatch(/^date_range\.relative: Invalid enum value\. .*received 'today'$/);
  });

  it('joins several problems', () => {
    expect(reason({ date_range: range, top_n: 'x', a: 1, b: 2 })).toBe('top_n: Expected number, received string; unknown keys "a", "b"');
  });
});
