import { z } from 'zod';
import { READS_GAM, type ToolDefinition, type ToolContext } from '../report-tool-builder.js';
import { listEnvelope } from '../envelope.js';
import { gamError, type GamErrorCode } from '../errors.js';

const inputSchema = z.object({}).strict();

export const healthCheckTool: ToolDefinition<typeof inputSchema> = {
  name: 'health_check',
  description:
    'End-to-end connectivity probe — verifies that the MCP can authenticate to Google, reach the Ad Manager API, ' +
    'and has permission to read the configured network. Calls listEntities for one company (lowest-cost GAM read), ' +
    'reports pass/fail and round-trip latency. Useful first call after setup or whenever the LLM sees mysterious tool errors.',
  input: inputSchema,
  annotations: READS_GAM,
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
      const { cause, code } = attributeFailure(message);
      // The whole point of this tool is to report the failure it exists to
      // catch, so it must fail on the wire (isError: true) like any other
      // broken call. The diagnosis attributeFailure() produces is not lost
      // for that -- it travels in details, named by the check that failed.
      return gamError(code, {
        check: 'listEntities',
        latency_ms,
        attributed_cause: cause,
        error_message: message,
        timezone: ctx.timezone,
      });
    }
  },
};

// Classifies a failure message into a human-readable cause and the
// GamErrorCode that best fits it. Both come from the same read of the
// message so the code and the diagnosis can never disagree.
function attributeFailure(message: string): { cause: string; code: GamErrorCode } {
  const m = message.toLowerCase();
  if (m.includes('401') || m.includes('unauthorized') || m.includes('invalid_grant')) {
    return { cause: 'auth (token mint failed or wrong service account)', code: 'AUTH_FAILED' };
  }
  if (m.includes('403') || m.includes('permission')) {
    return { cause: 'permission (service account lacks Ad Manager API access or wrong network)', code: 'AUTH_FAILED' };
  }
  if (m.includes('404')) {
    return { cause: 'wrong network code (GAM_NETWORK_CODE does not match any accessible network)', code: 'INTERNAL_ERROR' };
  }
  if (m.includes('enotfound') || m.includes('econnrefused') || m.includes('etimedout')) {
    return { cause: 'network (cannot reach admanager.googleapis.com)', code: 'INTERNAL_ERROR' };
  }
  if (m.includes('429') || m.includes('quota')) {
    return { cause: 'quota (GAM API rate limited — wait and retry)', code: 'QUOTA_EXCEEDED' };
  }
  return { cause: 'unknown — see error_message', code: 'INTERNAL_ERROR' };
}
