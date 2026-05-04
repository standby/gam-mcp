import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'node:module';
import { ALL_TOOLS } from './tools/index.js';
import type { ToolContext } from './report-tool-builder.js';
import { gamError } from './errors.js';
import { z } from 'zod';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export function listToolNames(): string[] {
  return ALL_TOOLS.map((t) => t.name);
}

export function installStdoutGuard(): () => void {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any, ...rest: any[]) => {
    const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    // MCP frames are newline-delimited JSON-RPC over stdio. Let those through.
    // JSON.stringify field order isn't fixed, so check for the marker anywhere
    // in the payload rather than only at the start.
    if (s.includes('"jsonrpc"') || s.startsWith('Content-Length:')) {
      return original(chunk, ...rest);
    }
    process.stderr.write(`[stdout-guard] ${s}`);
    return true;
  }) as typeof process.stdout.write;
  return () => { process.stdout.write = original; };
}

export async function startMcpServer(ctx: ToolContext): Promise<void> {
  const server = new Server(
    { name: 'gam-mcp', version: pkg.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.input),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = ALL_TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: JSON.stringify(gamError('INVALID_INPUT', { reason: `Unknown tool ${req.params.name}` })) }],
        isError: true,
      };
    }
    const parsed = tool.input.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        content: [{ type: 'text', text: JSON.stringify(gamError('INVALID_INPUT', { reason: parsed.error.message })) }],
        isError: true,
      };
    }
    try {
      const result = await tool.handler(parsed.data, ctx);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      return {
        content: [{ type: 'text', text: JSON.stringify(gamError('INTERNAL_ERROR', { reason: e instanceof Error ? e.message : String(e) })) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Minimal zod → JSON Schema. zod has many third-party converters; for v1 we
// emit a permissive schema that lets the LLM at least see field names.
function zodToJsonSchema(schema: z.ZodTypeAny): unknown {
  if (schema instanceof z.ZodObject) {
    const shape = (schema as z.ZodObject<any>).shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const key of Object.keys(shape)) {
      const sub = shape[key];
      properties[key] = zodToJsonSchema(sub);
      if (!sub.isOptional()) required.push(key);
    }
    return { type: 'object', properties, required };
  }
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodArray) return { type: 'array', items: zodToJsonSchema((schema as z.ZodArray<any>).element) };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: (schema as z.ZodEnum<any>).options };
  if (schema instanceof z.ZodOptional) return zodToJsonSchema((schema as z.ZodOptional<any>).unwrap());
  if (schema instanceof z.ZodUnion) return { anyOf: (schema as z.ZodUnion<any>).options.map(zodToJsonSchema) };
  if (schema instanceof z.ZodDefault) return zodToJsonSchema((schema as any)._def.innerType);
  // ZodEffects wraps the schema in .refine/.transform/.preprocess; descend.
  if (schema instanceof z.ZodEffects) return zodToJsonSchema((schema as z.ZodEffects<any>).innerType());
  return {};
}
