export type GamErrorCode =
  | 'INVALID_DATE_RANGE'
  | 'INVALID_INPUT'
  | 'AUTH_FAILED'
  | 'QUOTA_EXCEEDED'
  | 'REPORT_FAILED'
  | 'REPORT_TIMEOUT'
  | 'ENTITY_NOT_FOUND'
  | 'AMBIGUOUS_NAME'
  | 'UNSUPPORTED_DIMENSION_COMBO'
  | 'INTERNAL_ERROR';

export type GamErrorEnvelope = {
  error: {
    code: GamErrorCode;
    message: string;
    hint: string;
    details: Record<string, unknown>;
  };
};

type Renderer = (details: Record<string, unknown>) => { message: string; hint: string };

const CATALOG: Record<GamErrorCode, Renderer> = {
  INVALID_DATE_RANGE: (d) => ({
    message: `Invalid date range: ${d.reason ?? 'unknown reason'}.`,
    hint: 'Use YYYY-MM-DD strings, ensure start ≤ end, and pick an end date no later than yesterday in the network timezone.',
  }),
  INVALID_INPUT: (d) => ({
    message: `Invalid input: ${d.reason ?? 'see details'}.`,
    hint: String(d.hint ?? 'Check the tool input schema and try again.'),
  }),
  AUTH_FAILED: () => ({
    message: 'Failed to authenticate with the Google Ad Manager API.',
    hint: 'Check that GAM_SERVICE_ACCOUNT_KEY_FILE points to a readable service-account JSON and that the account has Ad Manager API access.',
  }),
  QUOTA_EXCEEDED: (d) => ({
    message: 'GAM API rate-limited this request.',
    hint: d.retry_after_seconds
      ? `Retry after ${d.retry_after_seconds}s.`
      : 'Wait and retry; consider narrowing the date range.',
  }),
  REPORT_FAILED: (d) => ({
    message: `Report job failed: ${d.reason ?? 'unknown'}.`,
    hint: 'Verify dimension/metric combinations are supported (call describe_schema) and filters reference real entities.',
  }),
  REPORT_TIMEOUT: (d) => ({
    message: `Report did not finish within ${d.timeout_ms ?? 300000}ms.`,
    hint: 'Narrow the date range, reduce dimensions, or set GAM_REPORT_TIMEOUT_MS higher.',
  }),
  ENTITY_NOT_FOUND: (d) => ({
    message: `No ${d.entity_type} matched ${JSON.stringify(d.query)}.`,
    hint: `Try lookup with entity_type: '${d.entity_type}' to see candidate matches.`,
  }),
  AMBIGUOUS_NAME: (d) => ({
    message: `Multiple ${d.entity_type}s matched ${JSON.stringify(d.query)}.`,
    hint: 'Pick a specific candidate from details.candidates and re-run with its numeric ID.',
  }),
  UNSUPPORTED_DIMENSION_COMBO: (d) => ({
    message: `Dimension combination not supported: ${d.dims}.`,
    hint: 'Call describe_schema to see allowed combinations.',
  }),
  INTERNAL_ERROR: (d) => ({
    message: `Internal error: ${d.reason ?? 'see logs'}.`,
    hint: 'Re-run; if it persists, check stderr logs for the correlation ID.',
  }),
};

export function gamError(
  code: GamErrorCode,
  details: Record<string, unknown> = {},
): GamErrorEnvelope {
  const { message, hint } = CATALOG[code](details);
  return { error: { code, message, hint, details } };
}

export function isGamError(x: unknown): x is GamErrorEnvelope {
  return (
    typeof x === 'object' &&
    x !== null &&
    'error' in x &&
    typeof (x as GamErrorEnvelope).error?.code === 'string'
  );
}
