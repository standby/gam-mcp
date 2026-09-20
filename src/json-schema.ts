import { z } from 'zod';
import { isDateField } from './tool-input.js';

export type JsonSchema = { [key: string]: unknown };

const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

// The advertised input schema of a tool (spec §3.1): descriptions, defaults,
// bounds, patterns, enums, `format: date` and `additionalProperties: false`
// for strict objects. Hand-built because SDK v1 has no converter of its own
// (spec D-5). A zod type it does not know throws, so a new kind of field
// cannot be advertised as an empty schema that accepts anything.
export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const { description: inner, ...node } = convert(schema);
  const description = schema.description ?? inner;
  return description === undefined ? node : { description, ...node };
}

function convert(s: z.ZodTypeAny): JsonSchema {
  if (s instanceof z.ZodOptional) return toJsonSchema(s.unwrap());
  if (s instanceof z.ZodDefault) return { ...toJsonSchema(s._def.innerType), default: s._def.defaultValue() };
  if (s instanceof z.ZodEffects) return toJsonSchema(s.innerType());
  if (s instanceof z.ZodObject) return objectSchema(s);
  if (s instanceof z.ZodString) return stringSchema(s);
  if (s instanceof z.ZodNumber) return numberSchema(s);
  if (s instanceof z.ZodBoolean) return { type: 'boolean' };
  if (s instanceof z.ZodEnum) return { type: 'string', enum: [...s.options] };
  if (s instanceof z.ZodLiteral) return { const: s.value };
  if (s instanceof z.ZodArray) return arraySchema(s);
  if (s instanceof z.ZodUnion) return { anyOf: s.options.map((o: z.ZodTypeAny) => toJsonSchema(o)) };
  throw new Error(`toJsonSchema: no JSON Schema for zod type ${String(s._def.typeName)}`);
}

function objectSchema(s: z.ZodObject<z.ZodRawShape>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(s.shape)) {
    properties[key] = toJsonSchema(field);
    if (!field.isOptional()) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 && { required }),
    ...(s._def.unknownKeys === 'strict' && { additionalProperties: false }),
  };
}

function stringSchema(s: z.ZodString): JsonSchema {
  if (isDateField(s)) return { type: 'string', format: 'date', pattern: DATE_PATTERN };
  const out: JsonSchema = { type: 'string' };
  for (const check of s._def.checks) {
    if (check.kind === 'min') out.minLength = check.value;
    else if (check.kind === 'max') out.maxLength = check.value;
    else if (check.kind === 'regex') out.pattern = check.regex.source;
    else throw new Error(`toJsonSchema: no JSON Schema for string check ${check.kind}`);
  }
  return out;
}

function numberSchema(s: z.ZodNumber): JsonSchema {
  const out: JsonSchema = { type: s.isInt ? 'integer' : 'number' };
  for (const check of s._def.checks) {
    if (check.kind === 'min') out[check.inclusive ? 'minimum' : 'exclusiveMinimum'] = check.value;
    else if (check.kind === 'max') out[check.inclusive ? 'maximum' : 'exclusiveMaximum'] = check.value;
    else if (check.kind !== 'int') throw new Error(`toJsonSchema: no JSON Schema for number check ${check.kind}`);
  }
  return out;
}

function arraySchema(s: z.ZodArray<z.ZodTypeAny>): JsonSchema {
  const { minLength, maxLength, exactLength } = s._def;
  return {
    type: 'array',
    items: toJsonSchema(s.element),
    ...((exactLength ?? minLength) && { minItems: (exactLength ?? minLength)!.value }),
    ...((exactLength ?? maxLength) && { maxItems: (exactLength ?? maxLength)!.value }),
  };
}
