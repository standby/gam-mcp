import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authOptionsFor, createAuthFetch, createGoogleAuth, failureKind, resolveAuthSource, SCOPES,
  type AuthSource, type GoogleAuthLike,
} from '../src/auth.js';
import { CredentialError } from '../src/errors.js';
import { createLogger } from '../src/log.js';

const ADMANAGER = 'https://www.googleapis.com/auth/admanager';
// Stands in for key material. Node's JSON parser quotes the first ten
// characters of what it failed to parse, so tests look for this prefix.
const SECRET = 'KEYMATERIAL-9d41c7';

describe('resolveAuthSource', () => {
  it('returns file source when GAM_SERVICE_ACCOUNT_KEY_FILE is set', () => {
    const r = resolveAuthSource({ GAM_SERVICE_ACCOUNT_KEY_FILE: '/etc/sa.json' } as NodeJS.ProcessEnv);
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.source).toEqual({ type: 'file', path: '/etc/sa.json' });
  });

  it('GAM_SERVICE_ACCOUNT_KEY_FILE wins over GAM_SERVICE_ACCOUNT_KEY_JSON (backwards-compat precedence)', () => {
    const r = resolveAuthSource({
      GAM_SERVICE_ACCOUNT_KEY_FILE: '/etc/sa.json',
      GAM_SERVICE_ACCOUNT_KEY_JSON: '{"type":"service_account"}',
    } as NodeJS.ProcessEnv);
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.source.type).toBe('file');
  });

  it('parses raw inline JSON', () => {
    const r = resolveAuthSource({
      GAM_SERVICE_ACCOUNT_KEY_JSON: '{"type":"service_account","client_email":"x@y.iam.gserviceaccount.com"}',
    } as NodeJS.ProcessEnv);
    if ('error' in r) throw new Error(JSON.stringify(r));
    if (r.source.type !== 'json') throw new Error('expected json source');
    expect(r.source.credentials.client_email).toBe('x@y.iam.gserviceaccount.com');
  });

  it('parses base64-encoded inline JSON', () => {
    const raw = '{"type":"service_account","client_email":"bz@y.iam.gserviceaccount.com"}';
    const b64 = Buffer.from(raw).toString('base64');
    const r = resolveAuthSource({ GAM_SERVICE_ACCOUNT_KEY_JSON: b64 } as NodeJS.ProcessEnv);
    if ('error' in r) throw new Error(JSON.stringify(r));
    if (r.source.type !== 'json') throw new Error('expected json source');
    expect(r.source.credentials.client_email).toBe('bz@y.iam.gserviceaccount.com');
  });

  it('returns an error envelope when KEY_JSON is malformed', () => {
    const r = resolveAuthSource({ GAM_SERVICE_ACCOUNT_KEY_JSON: 'not-json-or-base64' } as NodeJS.ProcessEnv);
    if (!('error' in r)) throw new Error('expected error');
    expect(r.error.code).toBe('AUTH_FAILED');
    expect(r.error.hint).toContain('base64');
  });

  it('falls through to ADC when no env vars are set', () => {
    const r = resolveAuthSource({} as NodeJS.ProcessEnv);
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.source).toEqual({ type: 'adc' });
  });
});

describe('createAuthFetch', () => {
  it('attaches Authorization header from auth client', async () => {
    const auth: GoogleAuthLike = {
      async getAccessToken() { return 'tok-12345678'; },
    };
    const inner = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer tok-12345678');
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const f = createAuthFetch(auth, inner as unknown as typeof fetch);
    const res = await f('https://admanager.googleapis.com/v1/networks/x/orders');
    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledOnce();
  });
});

describe('scope (spec D-6)', () => {
  it.each<AuthSource>([
    { type: 'file', path: '/nonexistent/key.json' },
    { type: 'json', credentials: { type: 'service_account', client_email: 'reader@example.iam.gserviceaccount.com' } },
    { type: 'adc' },
  ])('D1: the $type source asks for exactly the admanager scope', (source) => {
    expect(authOptionsFor(source)?.scopes).toEqual([ADMANAGER]);
  });

  it('D1: no other OAuth scope appears anywhere in src/', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const found = (readdirSync(src, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => [...readFileSync(join(src, f), 'utf8').matchAll(/https:\/\/www\.googleapis\.com\/auth\/[\w.]+/g)]
        .map((m) => m[0]));
    expect(found).toEqual([ADMANAGER]);
    expect(SCOPES).toEqual([ADMANAGER]);
  });
});

describe('credential failures', () => {
  async function failure(source: AuthSource) {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (l) => { lines.push(l); } });
    const err = await createGoogleAuth(source, logger).getAccessToken().then(
      () => { throw new Error('expected the credential to fail'); },
      (e: unknown) => e,
    );
    return { err, lines, text: `${(err as Error).message}\n${(err as Error).stack}\n${lines.join('')}` };
  }

  it('a key file that is not JSON fails as a CredentialError that quotes none of it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gam-auth-'));
    const path = join(dir, 'key.json');
    writeFileSync(path, `${SECRET} is not a service account key`);
    try {
      const { err, lines, text } = await failure({ type: 'file', path });
      expect(err).toBeInstanceOf(CredentialError);
      expect((err as Error).message).toBe('the file credential could not produce an access token (SyntaxError)');
      expect(text).not.toContain('KEYMAT');
      expect(lines.some((l) => l.includes('"msg":"auth.token_failure"') && l.includes('"reason":"SyntaxError"'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing key file names only the system error code', async () => {
    const { err } = await failure({ type: 'file', path: join(tmpdir(), `gam-auth-missing-${process.pid}`, 'key.json') });
    expect(err).toMatchObject({ name: 'CredentialError', source: 'file', reason: 'Error ENOENT' });
  });

  it('an inline key that cannot sign fails without quoting the key', async () => {
    const { err, text } = await failure({
      type: 'json',
      credentials: {
        type: 'service_account',
        client_email: 'reader@example.iam.gserviceaccount.com',
        private_key: `-----BEGIN PRIVATE KEY-----\n${SECRET}\n-----END PRIVATE KEY-----\n`,
      },
    });
    expect(err).toMatchObject({ name: 'CredentialError', source: 'json' });
    expect(text).not.toContain('KEYMAT');
  });
});

describe('failureKind', () => {
  it('keeps the error class, codes and statuses and drops every message', () => {
    const e = Object.assign(new Error(`invalid_grant: ${SECRET}`), {
      name: 'GaxiosError',
      code: '400',
      response: { status: 400, data: { error: 'invalid_grant', error_description: SECRET } },
    });
    expect(failureKind(e)).toBe('GaxiosError 400 HTTP 400 invalid_grant');
  });

  it('ignores anything that is not a short word', () => {
    expect(failureKind({ name: `bad ${SECRET}`, code: 'x'.repeat(80) })).toBe('unknown failure');
    expect(failureKind('a string')).toBe('unknown failure');
    expect(failureKind(undefined)).toBe('unknown failure');
  });
});

describe('inline credential errors do not echo the value (fix round 1)', () => {
  const SENTINEL = 'SENTINEL_KEY_MATERIAL';
  // Unquoted value forces JSON.parse's own error to quote a slice of the raw
  // text starting right at the sentinel (Node quotes the first ~10 characters
  // of what it failed to parse there).
  const MALFORMED = `{"private_key": ${SENTINEL}}`;

  // Every contiguous 8-character slice of `raw` must be absent from `text` —
  // stronger than checking the sentinel alone, since it also catches a leak
  // of surrounding JSON syntax (quotes, key names) around the failure point.
  function assertNoSliceLeaks(text: string, raw: string): void {
    for (let i = 0; i + 8 <= raw.length; i++) {
      expect(text).not.toContain(raw.slice(i, i + 8));
    }
  }

  it('a malformed raw inline value is reported without echoing it', () => {
    const r = resolveAuthSource({ GAM_SERVICE_ACCOUNT_KEY_JSON: MALFORMED } as NodeJS.ProcessEnv);
    if (!('error' in r)) throw new Error('expected error');
    const text = `${r.error.message}\n${r.error.hint}`;
    expect(text).not.toContain(SENTINEL);
    assertNoSliceLeaks(text, MALFORMED);
    expect(r.error.message).toContain('GAM_SERVICE_ACCOUNT_KEY_JSON');
  });

  it('a base64-encoded malformed inline value is reported without echoing it', () => {
    const b64 = Buffer.from(MALFORMED).toString('base64');
    const r = resolveAuthSource({ GAM_SERVICE_ACCOUNT_KEY_JSON: b64 } as NodeJS.ProcessEnv);
    if (!('error' in r)) throw new Error('expected error');
    const text = `${r.error.message}\n${r.error.hint}`;
    expect(text).not.toContain(SENTINEL);
    assertNoSliceLeaks(text, MALFORMED);
    expect(r.error.message).toContain('GAM_SERVICE_ACCOUNT_KEY_JSON');
  });
});
