import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'node:module';
import { ALL_TOOLS } from './tools/index.js';
import { GAM_SCHEMA } from './schema.js';
import { PROMPTS, renderPrompt } from './prompts.js';
import type { ToolContext, ToolDefinition } from './report-tool-builder.js';
import { gamError, isGamError } from './errors.js';
import type { ZodTypeAny } from 'zod';
import { toJsonSchema } from './json-schema.js';
import { describeInputError } from './tool-input.js';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export function listToolNames(): string[] {
  return ALL_TOOLS.map((t) => t.name);
}

type ResourceDef = {
  uri: string;
  name: string;
  description: string;
  body: () => unknown;
};

const RESOURCES: ResourceDef[] = [
  {
    uri: 'gam://schema',
    name: 'Full curated GAM schema',
    description: 'Full curated catalog of dimensions and metrics this MCP can query, with descriptions tuned for LLM consumption.',
    body: () => GAM_SCHEMA,
  },
  {
    uri: 'gam://schema/dimensions',
    name: 'GAM dimensions',
    description: 'Available report dimensions (date, advertiser, line item, ad unit, country, custom dimensions, etc.).',
    body: () => ({ dimensions: GAM_SCHEMA.dimensions }),
  },
  {
    uri: 'gam://schema/metrics',
    name: 'GAM metrics',
    description: 'Available report metrics (impressions, revenue, eCPM, AdX/AdSense channel metrics, viewability, etc.).',
    body: () => ({ metrics: GAM_SCHEMA.metrics }),
  },
];

export function listResources(): ResourceDef[] {
  return RESOURCES;
}

function networkResource(networkCode: string, timezone: string): ResourceDef {
  return {
    uri: 'gam://network',
    name: 'GAM network identity',
    description: 'Network code and configured timezone this MCP is reporting on.',
    body: () => ({ network_code: networkCode, timezone }),
  };
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

// Build the MCP Server with every capability and tool registered, but don't
// connect a transport yet. Callers choose how to connect (stdio, HTTP, etc.)
// — this split lets us keep the existing stdio entrypoint unchanged while
// supporting alternate transports.
export function buildMcpServer(
  ctx: ToolContext,
  opts: { networkCode: string; tools?: ToolDefinition<ZodTypeAny>[] } = { networkCode: '' },
): Server {
  const tools = opts.tools ?? ALL_TOOLS;
  const server = new Server(
    { name: 'gam-mcp', version: pkg.version },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  const resources = [
    ...RESOURCES,
    ...(opts.networkCode ? [networkResource(opts.networkCode, ctx.timezone)] : []),
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: toJsonSchema(t.input),
    })),
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: 'application/json',
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const r = resources.find((x) => x.uri === req.params.uri);
    if (!r) {
      throw new Error(`Unknown resource: ${req.params.uri}`);
    }
    return {
      contents: [{
        uri: r.uri,
        mimeType: 'application/json',
        text: JSON.stringify(r.body(), null, 2),
      }],
    };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments.map((a) => ({
        name: a.name,
        description: a.description,
        required: a.required,
      })),
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, string>;
    const rendered = renderPrompt(req.params.name, args);
    if (!rendered) {
      throw new Error(`Unknown prompt: ${req.params.name}`);
    }
    return {
      description: rendered.description,
      messages: [
        { role: 'user', content: { type: 'text', text: rendered.text } },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolName = req.params.name;
    const argKeys = Object.keys(req.params.arguments ?? {});
    ctx.logger.info('tool.call.start', { tool: toolName, arg_keys: argKeys });
    const start = Date.now();

    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      const err = gamError('INVALID_INPUT', { reason: `Unknown tool ${toolName}` });
      ctx.logger.warn('tool.call.error', { tool: toolName, error_code: err.error.code, reason: err.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(err) }], isError: true };
    }
    const parsed = tool.input.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      const err = gamError('INVALID_INPUT', { reason: describeInputError(parsed.error) });
      ctx.logger.warn('tool.call.error', { tool: toolName, error_code: err.error.code, reason: err.error.message });
      return { content: [{ type: 'text', text: JSON.stringify(err) }], isError: true };
    }
    try {
      const result = await tool.handler(parsed.data, ctx);
      const duration_ms = Date.now() - start;
      if (isGamError(result)) {
        ctx.logger.warn('tool.call.error', { tool: toolName, error_code: result.error.code, reason: result.error.message });
        ctx.logger.info('tool.call.end', { tool: toolName, duration_ms, ok: false });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: true };
      }
      ctx.logger.info('tool.call.end', { tool: toolName, duration_ms, ok: true });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      const duration_ms = Date.now() - start;
      const reason = e instanceof Error ? e.message : String(e);
      const err = gamError('INTERNAL_ERROR', { reason });
      ctx.logger.warn('tool.call.error', { tool: toolName, error_code: err.error.code, reason });
      ctx.logger.info('tool.call.end', { tool: toolName, duration_ms, ok: false });
      return { content: [{ type: 'text', text: JSON.stringify(err) }], isError: true };
    }
  });

  return server;
}

export async function startMcpServer(
  ctx: ToolContext,
  opts: { networkCode: string } = { networkCode: '' },
): Promise<void> {
  const server = buildMcpServer(ctx, opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
