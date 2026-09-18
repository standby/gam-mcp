import { z } from 'zod';
import { READS_GAM, type ToolDefinition, type ToolContext } from '../report-tool-builder.js';
import { listEnvelope } from '../envelope.js';
import { gamError, type GamErrorCode } from '../errors.js';
import { GamHttpError } from '../gam-client.js';

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
          // A number, like error.details.latency_ms below -- both name the
          // same duration and should read the same way.
          latency_ms,
          companies_visible: String(entities.length > 0),
          timezone: ctx.timezone,
        }],
        `Health check passed in ${latency_ms}ms. Auth, network, and permissions all working.`,
      );
    } catch (e) {
      const latency_ms = Date.now() - start;
      const { cause, code, message } = attributeFailure(e);
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

type Diagnosis = { cause: string; code: GamErrorCode; message: string };

// Classifies a failure into a human-readable cause and the GamErrorCode that
// best fits it. The REST client's listEntities throws a typed GamHttpError
// with a real HTTP status for anything the network answered (root cause of
// the old string-only heuristic; see gam-client-rest.ts's httpError()), so
// that status is read first -- it is GAM's own answer, not a guess. The
// substring read of the message is the fallback for failures that never got
// an HTTP status at all, such as ENOTFOUND/ECONNREFUSED/ETIMEDOUT before any
// response existed, or a plain Error from somewhere else in the call chain.
function attributeFailure(e: unknown): Diagnosis {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof GamHttpError) {
    const byStatus = attributeStatus(e.status);
    if (byStatus) return { ...byStatus, message };
  }
  return { ...attributeMessage(message), message };
}

function attributeStatus(status: number): { cause: string; code: GamErrorCode } | null {
  switch (status) {
    case 401: return { cause: 'auth (token mint failed or wrong service account)', code: 'AUTH_FAILED' };
    case 403: return { cause: 'permission (service account lacks Ad Manager API access or wrong network)', code: 'AUTH_FAILED' };
    case 404: return { cause: 'wrong network code (GAM_NETWORK_CODE does not match any accessible network)', code: 'INTERNAL_ERROR' };
    case 429: return { cause: 'quota (GAM API rate limited — wait and retry)', code: 'QUOTA_EXCEEDED' };
    default: return null;
  }
}

function attributeMessage(message: string): { cause: string; code: GamErrorCode } {
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
