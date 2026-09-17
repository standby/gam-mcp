import { GoogleAuth } from 'google-auth-library';
import { CredentialError, gamError } from './errors.js';
import type { Logger } from './log.js';
import { noopLogger } from './log.js';

export type GoogleAuthLike = {
  getAccessToken: () => Promise<string | null | undefined>;
};

// Three ways to authenticate, in increasing order of magic:
//   - `file`: explicit path to a service-account JSON key.
//   - `json`: the JSON itself, supplied inline (raw or base64). Useful in
//      hosted environments where mounting a key file is awkward.
//   - `adc`: Application Default Credentials. google-auth-library auto-
//      discovers via GOOGLE_APPLICATION_CREDENTIALS, `gcloud auth`-stashed
//      tokens, or the GCE/Cloud Run metadata server.
export type AuthSource =
  | { type: 'file'; path: string }
  | { type: 'json'; credentials: Record<string, unknown> }
  | { type: 'adc' };

// The only scope any credential asks for (spec D-6): admanager.readonly cannot
// create reports. Read-only behaviour is held by what the client can send
// (test H7), not by the scope.
export const SCOPES = ['https://www.googleapis.com/auth/admanager'];

export function createGoogleAuth(source: AuthSource, logger: Logger = noopLogger()): GoogleAuthLike {
  const auth = new GoogleAuth(authOptionsFor(source));
  return {
    async getAccessToken() {
      logger.debug('auth.token_refresh', { source: source.type });
      try {
        const client = await auth.getClient();
        const t = await client.getAccessToken();
        return t.token ?? null;
      } catch (e) {
        // The library's messages can quote the key it failed to parse, so only
        // the failure's kind is logged or passed on.
        const reason = failureKind(e);
        logger.error('auth.token_failure', { source: source.type, reason });
        throw new CredentialError(source.type, reason);
      }
    },
  };
}

export function authOptionsFor(source: AuthSource): ConstructorParameters<typeof GoogleAuth>[0] {
  switch (source.type) {
    case 'file': return { keyFile: source.path, scopes: SCOPES };
    case 'json': return { credentials: source.credentials as never, scopes: SCOPES };
    case 'adc':  return { scopes: SCOPES };
  }
}

const SAFE_WORD = /^[A-Za-z0-9_.-]{1,64}$/;

// What kind of failure the auth library reported (error class, system or
// OpenSSL code, HTTP status, OAuth error code), without any of its text.
export function failureKind(e: unknown): string {
  const x = (typeof e === 'object' && e !== null ? e : {}) as {
    name?: unknown;
    code?: unknown;
    response?: { status?: unknown; data?: { error?: unknown } };
  };
  const parts: string[] = [];
  if (typeof x.name === 'string' && SAFE_WORD.test(x.name)) parts.push(x.name);
  if (typeof x.code === 'string' && SAFE_WORD.test(x.code)) parts.push(x.code);
  if (typeof x.response?.status === 'number') parts.push(`HTTP ${x.response.status}`);
  const oauth = x.response?.data?.error;
  if (typeof oauth === 'string' && SAFE_WORD.test(oauth)) parts.push(oauth);
  return parts.length > 0 ? parts.join(' ') : 'unknown failure';
}

// Inspect env and pick the right credential source. Precedence:
//   1. GAM_SERVICE_ACCOUNT_KEY_FILE  (legacy / always-wins for backwards compat)
//   2. GAM_SERVICE_ACCOUNT_KEY_JSON  (raw JSON or base64-encoded JSON)
//   3. ADC (no env var set → google-auth-library discovers)
//
// Returns a discriminated result so the caller can surface a single clear
// startup error if the JSON env var is set but malformed. Missing-everything
// is NOT an error here — ADC can legitimately succeed (e.g. on GCE/Cloud Run)
// without any explicit env var.
export type ResolveResult =
  | { source: AuthSource }
  | { error: { code: 'AUTH_FAILED'; message: string; hint: string } };

export function resolveAuthSource(env: NodeJS.ProcessEnv): ResolveResult {
  const file = env.GAM_SERVICE_ACCOUNT_KEY_FILE;
  if (file) return { source: { type: 'file', path: file } };

  const inline = env.GAM_SERVICE_ACCOUNT_KEY_JSON;
  if (inline) {
    const decoded = decodeInlineCredentials(inline);
    if ('error' in decoded) {
      return {
        error: {
          code: 'AUTH_FAILED',
          message: `GAM_SERVICE_ACCOUNT_KEY_JSON is set but is not valid JSON: ${decoded.error}`,
          hint: 'Pass raw service-account JSON or base64-encoded JSON. Check for shell-quoting issues (newlines in env vars often need base64).',
        },
      };
    }
    return { source: { type: 'json', credentials: decoded.credentials } };
  }

  return { source: { type: 'adc' } };
}

function decodeInlineCredentials(raw: string): { credentials: Record<string, unknown> } | { error: string } {
  // Raw JSON: starts with `{`. Anything else: try base64-decode first, then parse.
  const trimmed = raw.trim();
  const jsonText = trimmed.startsWith('{')
    ? trimmed
    : tryBase64Decode(trimmed);
  if (jsonText === null) return { error: 'value does not look like JSON or base64' };
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) return { error: 'JSON value is not an object' };
    return { credentials: parsed };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function tryBase64Decode(s: string): string | null {
  try {
    const decoded = Buffer.from(s, 'base64').toString('utf8');
    // Reject obvious non-JSON garbage so we surface a useful error instead of
    // a confusing "Unexpected token" later.
    if (!decoded.trim().startsWith('{')) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function createAuthFetch(
  auth: GoogleAuthLike,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const token = await auth.getAccessToken();
    if (!token) throw new Error(JSON.stringify(gamError('AUTH_FAILED')));
    const headers: Record<string, string> = {};
    if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, name) => {
          headers[name] = value;
        });
      } else if (Array.isArray(init.headers)) {
        init.headers.forEach(([name, value]) => {
          headers[name] = value;
        });
      } else {
        Object.assign(headers, init.headers);
      }
    }
    headers.Authorization = `Bearer ${token}`;
    return baseFetch(input, { ...init, headers });
  }) as typeof fetch;
}
