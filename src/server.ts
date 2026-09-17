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
import type { Readable, Writable } from 'node:stream';
import { toolsFor, type TransportMode } from './tools/index.js';
import { GAM_SCHEMA } from './schema.js';
import { PROMPTS, renderPrompt } from './prompts.js';
import type { ToolContext, ToolDefinition } from './report-tool-builder.js';
import { gamError, isGamError, type GamErrorEnvelope } from './errors.js';
import { toJsonSchema } from './json-schema.js';
import { describeInputError } from './tool-input.js';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export function listToolNames(mode: TransportMode = 'stdio'): string[] {
  return toolsFor(mode).map((t) => t.name);
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

function networkResource(ctx: ToolContext): ResourceDef {
  return {
    uri: 'gam://network',
    name: 'GAM network identity',
    description:
      'The network this MCP reports on, its currency, the time zone GAM counts report days in, ' +
      'and the time zone dates are chosen in (GAM_TIMEZONE).',
    body: () => ({
      network_code: ctx.networkCode,
      currency_code: ctx.currencyCode,
      report_time_zone: ctx.reportTimeZone,
      date_time_zone: ctx.timezone,
    }),
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

export type ServerOptions = {
  // Which transport the server is built for; it decides the tool set.
  mode: TransportMode;
  // Replaces the mode's tool set (tests).
  tools?: ToolDefinition[];
};

// Build the MCP Server with every capability and the mode's tools
// registered, but don't connect a transport yet: stdio connects one server,
// HTTP builds one per request.
export function buildMcpServer(ctx: ToolContext, opts: ServerOptions): Server {
  const tools = opts.tools ?? toolsFor(opts.mode);
  const server = new Server(
    { name: 'gam-mcp', version: pkg.version },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  const resources = [...RESOURCES, networkResource(ctx)];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: toJsonSchema(t.input),
      annotations: t.annotations,
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
    const end = (ok: boolean) => ctx.logger.info('tool.call.end', { tool: toolName, duration_ms: Date.now() - start, ok });
    // Every way a call can fail ends here: flagged, logged, and closed with
    // one tool.call.end line like a success.
    const failed = (err: GamErrorEnvelope) => {
      ctx.logger.warn('tool.call.error', { tool: toolName, error_code: err.error.code, reason: err.error.message });
      end(false);
      return { content: [{ type: 'text' as const, text: JSON.stringify(err) }], isError: true };
    };

    const tool = tools.find((t) => t.name === toolName);
    if (!tool) return failed(gamError('INVALID_INPUT', { reason: `Unknown tool ${toolName}` }));
    const parsed = tool.input.safeParse(req.params.arguments ?? {});
    if (!parsed.success) return failed(gamError('INVALID_INPUT', { reason: describeInputError(parsed.error) }));
    try {
      const result = await tool.handler(parsed.data, ctx);
      if (isGamError(result)) return failed(result);
      end(true);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      return failed(gamError('INTERNAL_ERROR', { reason: e instanceof Error ? e.message : String(e) }));
    }
  });

  return server;
}

// Serves over stdio: this process's stdin and stdout, or the streams given.
export async function connectStdio(
  ctx: ToolContext,
  io: { stdin: Readable; stdout: Writable } = { stdin: process.stdin, stdout: process.stdout },
): Promise<Server> {
  const server = buildMcpServer(ctx, { mode: 'stdio' });
  await server.connect(new StdioServerTransport(io.stdin, io.stdout));
  return server;
}
