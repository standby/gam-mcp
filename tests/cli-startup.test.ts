import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// D2 needs a real process: the exit code and stderr a deployer sees. Every
// case breaks the credential (or the settings) before a request could be
// made, and the environment is built from scratch, so nothing leaves this
// machine and no developer credential is picked up.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli.js');
const SECRET = 'KEYMATERIAL-9d41c7';

function start(env: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), 'gam-cli-home-'));
  try {
    return spawnSync(process.execPath, [CLI], {
      env: { PATH: process.env.PATH ?? '', HOME: home, GAM_NETWORK_CODE: '1234', ...env },
      input: '',
      encoding: 'utf8',
      timeout: 20_000,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('startup (real process)', () => {
  beforeAll(() => {
    // Build here so these cases never run a stale dist/.
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' });
  }, 120_000);

  it('D2: a key file that is not a key stops startup with exit 2, naming the source and quoting nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gam-cli-key-'));
    const keyFile = join(dir, 'key.json');
    writeFileSync(keyFile, `${SECRET} is not a service account key`);
    try {
      const r = start({ GAM_SERVICE_ACCOUNT_KEY_FILE: keyFile });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('cannot read network 1234 with the file credential');
      expect(r.stderr).toContain('GAM was not reached');
      expect(r.stderr).not.toContain('KEYMAT');
      expect(r.stdout).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('D2: an inline key that cannot sign stops startup with exit 2, quoting nothing', () => {
    const key = JSON.stringify({
      type: 'service_account',
      client_email: 'reader@example.iam.gserviceaccount.com',
      private_key: `-----BEGIN PRIVATE KEY-----\n${SECRET}\n-----END PRIVATE KEY-----\n`,
    });
    const r = start({ GAM_SERVICE_ACCOUNT_KEY_JSON: key });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot read network 1234 with the json credential');
    expect(r.stderr).not.toContain('KEYMAT');
  }, 30_000);

  it('a network code that is not a number stops startup before the credential is used', () => {
    const r = start({ GAM_NETWORK_CODE: '12a4', GAM_SERVICE_ACCOUNT_KEY_FILE: '/nonexistent/key.json' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('GAM_NETWORK_CODE must be the numeric network code');
    expect(r.stderr).not.toContain('auth.source_resolved');
  }, 30_000);

  it('D4: an unknown GAM_TIMEZONE stops startup before the credential is used', () => {
    const r = start({ GAM_TIMEZONE: 'Mars/Olympus', GAM_SERVICE_ACCOUNT_KEY_FILE: '/nonexistent/key.json' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('GAM_TIMEZONE="Mars/Olympus" is not an IANA time zone name');
    expect(r.stderr).not.toContain('auth.source_resolved');
  }, 30_000);

  it('a GAM_REPORT_CACHE_DIR that cannot be created stops startup with exit 2, naming it, before the credential is used', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gam-cli-cache-'));
    const file = join(dir, 'not-a-directory');
    writeFileSync(file, '');
    try {
      const r = start({ GAM_REPORT_CACHE_DIR: join(file, 'cache'), GAM_SERVICE_ACCOUNT_KEY_FILE: '/nonexistent/key.json' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`gam-mcp: GAM_REPORT_CACHE_DIR=${JSON.stringify(join(file, 'cache'))}`);
      expect(r.stderr).not.toContain('fatal');
      expect(r.stderr).not.toMatch(/^\s+at /m);
      expect(r.stderr).not.toContain('auth.source_resolved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // An invalid GAM_HTTP_PORT is quoted in the error, so a value containing a
  // newline stays on one line inside the message and cannot fake a line on
  // stderr, such as an http.listening log line a deployer's monitoring might
  // match on.
  it('a GAM_HTTP_PORT containing a fake log line cannot inject that line into stderr', () => {
    const injected = '8080\n{"level":"info","msg":"http.listening"}';
    const r = start({ GAM_HTTP_PORT: injected, GAM_SERVICE_ACCOUNT_KEY_FILE: '/nonexistent/key.json' });
    expect(r.status).toBe(2);
    const fakedLogLine = (r.stderr ?? '').split('\n').some((line) => {
      try {
        const parsed = JSON.parse(line) as { msg?: unknown };
        return parsed.msg === 'http.listening';
      } catch {
        return false;
      }
    });
    expect(fakedLogLine).toBe(false);
  }, 30_000);

  // An unusable credential stops HTTP mode before it listens: the identity
  // check runs before the HTTP transport is started, so http.listening must
  // never appear in stderr.
  it('D2: GAM_HTTP_PORT set with an unusable credential stops startup with exit 2 and never logs http.listening', () => {
    const r = start({
      GAM_HTTP_PORT: '38181',
      GAM_SERVICE_ACCOUNT_KEY_FILE: '/nonexistent/key.json',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot read network 1234 with the file credential');
    expect(r.stderr).not.toContain('http.listening');
  }, 30_000);

  // Node's JSON parser quotes part of its input in some of its error
  // messages, so the input here is built to trigger that (an unquoted value
  // makes the parser's error quote a slice of raw text starting right at the
  // sentinel — not every malformed string does this) and the test checks
  // none of that reaches stderr.
  it('D2: a malformed GAM_SERVICE_ACCOUNT_KEY_JSON stops startup with exit 2, quoting neither the sentinel nor the value', () => {
    const SENTINEL = 'SENTINEL_KEY_MATERIAL';
    const MALFORMED = `{"private_key": ${SENTINEL}}`;
    const r = start({ GAM_SERVICE_ACCOUNT_KEY_JSON: MALFORMED });
    expect(r.status).toBe(2);
    // Pins where startup stopped, not just that it did.
    expect(r.stderr).toContain('GAM_SERVICE_ACCOUNT_KEY_JSON is not valid JSON');
    expect(r.stderr).not.toContain(SENTINEL);
    for (let i = 0; i + 8 <= MALFORMED.length; i++) {
      expect(r.stderr).not.toContain(MALFORMED.slice(i, i + 8));
    }
  }, 30_000);

  it('HTTP settings are checked before the credential, and the token is never quoted', () => {
    const noKey = { GAM_SERVICE_ACCOUNT_KEY_FILE: '/nonexistent/key.json' };
    const port = start({ ...noKey, GAM_HTTP_PORT: '1e3' });
    expect(port.status).toBe(2);
    expect(port.stderr).toContain('GAM_HTTP_PORT must be a valid port number, got "1e3"');

    const hosts = start({ ...noKey, GAM_HTTP_PORT: '38182', GAM_HTTP_ALLOWED_HOSTS: 'gam-mcp.internal:8080' });
    expect(hosts.status).toBe(2);
    expect(hosts.stderr).toContain('GAM_HTTP_ALLOWED_HOSTS must list host names without ports');

    const token = start({ ...noKey, GAM_HTTP_PORT: '38183', GAM_HTTP_BEARER_TOKEN: `${SECRET} with spaces` });
    expect(token.status).toBe(2);
    expect(token.stderr).toContain('GAM_HTTP_BEARER_TOKEN must be printable ASCII with no spaces');
    expect(token.stderr).not.toContain('KEYMAT');

    for (const r of [port, hosts, token]) expect(r.stderr).not.toContain('auth.source_resolved');
  }, 30_000);

  // ignoredInStdio (Task 13) is unit-tested, but nothing before this asserted
  // that a real stdio process actually emits the warning rather than silently
  // dropping an HTTP-only setting. GAM_HTTP_PORT stays unset, so this is
  // stdio mode; the credential still fails, confirming startup ran past the
  // warning and never reached the HTTP-settings validation above.
  it('a stdio run with HTTP-only settings set warns config.ignored for each, then still proceeds', () => {
    const r = start({
      GAM_HTTP_BEARER_TOKEN: 'stdio-run-ignored-token-9d41c7',
      GAM_HTTP_ALLOWED_HOSTS: 'gam-mcp.internal',
      GAM_SERVICE_ACCOUNT_KEY_FILE: '/nonexistent/key.json',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot read network 1234 with the file credential');

    const ignoredVariables: unknown[] = [];
    for (const line of (r.stderr ?? '').split('\n')) {
      try {
        const parsed = JSON.parse(line) as { msg?: unknown; variable?: unknown };
        if (parsed.msg === 'config.ignored') ignoredVariables.push(parsed.variable);
      } catch {
        // not a JSON log line
      }
    }
    expect(ignoredVariables).toEqual(['GAM_HTTP_BEARER_TOKEN', 'GAM_HTTP_ALLOWED_HOSTS']);
  }, 30_000);
});
