import { GoogleAuth } from 'google-auth-library';
import { gamError } from './errors.js';

export type GoogleAuthLike = {
  getAccessToken: () => Promise<string | null | undefined>;
};

export function createGoogleAuth(keyFile: string): GoogleAuthLike {
  const auth = new GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/admanager'],
  });
  return {
    async getAccessToken() {
      const client = await auth.getClient();
      const t = await client.getAccessToken();
      return t.token ?? null;
    },
  };
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
