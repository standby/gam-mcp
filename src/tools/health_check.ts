import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../report-tool-builder.js';
import { listEnvelope } from '../envelope.js';

const inputSchema = z.object({});

export const healthCheckTool: ToolDefinition<typeof inputSchema> = {
  name: 'health_check',
  description:
    'End-to-end connectivity probe — verifies that the MCP can authenticate to Google, reach the Ad Manager API, ' +
    'and has permission to read the configured network. Calls listEntities for one company (lowest-cost GAM read), ' +
    'reports pass/fail and round-trip latency. Useful first call after setup or whenever the LLM sees mysterious tool errors.',
  input: inputSchema,
  async handler(_input, ctx: ToolContext) {
    const start = Date.now();
    try {
      const entities = await ctx.client.listEntities({ entity_type: 'company', limit: 1 });
      const latency_ms = Date.now() - start;
      return listEnvelope(
        [{
          status: 'ok',
          latency_ms: String(latency_ms),
          companies_visible: String(entities.length > 0),
          timezone: ctx.timezone,
        }],
        `Health check passed in ${latency_ms}ms. Auth, network, and permissions all working.`,
      );
    } catch (e) {
      const latency_ms = Date.now() - start;
      const message = e instanceof Error ? e.message : String(e);
      const cause = attributeFailure(message);
      // Return a SUCCESS envelope (not an error envelope) so the LLM sees the
      // diagnostic detail rather than a generic INTERNAL_ERROR. The whole
      // point of this tool is to surface the failure, not to fail itself.
      return listEnvelope(
        [{
          status: 'failed',
          latency_ms: String(latency_ms),
          attributed_cause: cause,
          error_message: message,
          timezone: ctx.timezone,
        }],
        `Health check FAILED after ${latency_ms}ms — likely ${cause}.`,
      );
    }
  },
};

function attributeFailure(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('401') || m.includes('unauthorized') || m.includes('invalid_grant')) return 'auth (token mint failed or wrong service account)';
  if (m.includes('403') || m.includes('permission')) return 'permission (service account lacks Ad Manager API access or wrong network)';
  if (m.includes('404')) return 'wrong network code (GAM_NETWORK_CODE does not match any accessible network)';
  if (m.includes('enotfound') || m.includes('econnrefused') || m.includes('etimedout')) return 'network (cannot reach admanager.googleapis.com)';
  if (m.includes('429') || m.includes('quota')) return 'quota (GAM API rate limited — wait and retry)';
  return 'unknown — see error_message';
}
