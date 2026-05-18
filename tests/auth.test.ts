import { describe, it, expect, vi } from 'vitest';
import { createAuthFetch, resolveAuthSource, type GoogleAuthLike } from '../src/auth.js';

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
