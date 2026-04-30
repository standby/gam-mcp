import { describe, it, expect, vi } from 'vitest';
import { createAuthFetch, type GoogleAuthLike } from '../src/auth.js';

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
