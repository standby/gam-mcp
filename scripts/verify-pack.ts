// Release gate: pack the package as npm would, install the tarball into a
// throwaway directory, spawn the published bin, and verify it actually
// behaves as an MCP stdio server.
//
// Two modes, auto-detected from the environment:
//   - Env-less (CI / prepublishOnly): start the bin without GAM creds and
//     assert it exits 2 with the documented "is required" error. Verifies
//     packaging mechanics (files field, bin path, shebang, dist contents).
//   - Env-present (local dev): full MCP handshake — initialize, tools/list,
//     tools/call describe_schema. Verifies the protocol layer end-to-end,
//     which unit tests don't reach.
//
// Either mode catches the class of bug shipped in 0.1.4 (stdout guard
// diverting JSON-RPC frames) before the version tag is created.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);

function log(msg: string): void {
  process.stderr.write(`verify-pack: ${msg}\n`);
}

function fail(msg: string): never {
  process.stderr.write(`verify-pack: FAIL — ${msg}\n`);
  process.exit(1);
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): { stdout: string; stderr: string; status: number } {
  // Under `npm publish --dry-run` npm exports npm_config_dry_run=true to this
  // script, and every nested npm command would inherit it: `npm pack` would
  // write no tarball and `npm install` would install nothing. This gate must
  // really pack and install, so drop it.
  const env = { ...process.env };
  delete env.npm_config_dry_run;
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? repoRoot, encoding: 'utf8', env });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

function rpc(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
}

async function handshake(binPath: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    const child = spawn(binPath, [], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.stdin.write(rpc(1, 'initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-pack', version: '0' },
    }) + '\n');
    child.stdin.write(rpc(2, 'tools/list') + '\n');
    child.stdin.write(rpc(3, 'tools/call', { name: 'describe_schema', arguments: { kind: 'all' } }) + '\n');
    setTimeout(() => {
      child.kill('SIGTERM');
      resolveP({ stdout, stderr });
    }, 3000);
  });
}

async function main(): Promise<void> {
  // Step 1: build, so dist/ is current.
  log('building...');
  const build = run('npm', ['run', 'build']);
  if (build.status !== 0) fail(`build failed:\n${build.stderr}`);

  // Step 2: pack. npm pack prints the tarball filename to stdout (last line).
  log('packing...');
  const pack = run('npm', ['pack', '--silent']);
  if (pack.status !== 0) fail(`npm pack failed:\n${pack.stderr}`);
  const tarballName = pack.stdout.trim().split('\n').pop() ?? '';
  const tarballPath = join(repoRoot, tarballName);
  if (!existsSync(tarballPath)) fail(`tarball not found at ${tarballPath}`);
  log(`tarball: ${tarballName}`);

  // Step 3: install into a throwaway project. This exercises the same
  // resolution path npx uses, including running any install hooks.
  const tmp = mkdtempSync(join(tmpdir(), 'gam-mcp-verify-'));
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    try { unlinkSync(tarballPath); } catch { /* ignore */ }
  };
  process.on('exit', cleanup);

  try {
    log(`installing into ${tmp}`);
    const init = run('npm', ['init', '-y'], { cwd: tmp });
    if (init.status !== 0) fail(`npm init failed:\n${init.stderr}`);
    const install = run('npm', ['install', tarballPath, '--no-audit', '--no-fund', '--loglevel=error'], { cwd: tmp });
    if (install.status !== 0) fail(`npm install failed:\n${install.stderr}`);

    const binPath = join(tmp, 'node_modules', '.bin', 'gam-mcp');
    if (!existsSync(binPath)) fail(`bin not present at ${binPath}; check files/bin in package.json`);

    // Step 4a: env-less smoke. Bin must start, fail fast on missing env.
    log('env-less startup check...');
    const sanitizedEnv: NodeJS.ProcessEnv = { ...process.env };
    delete sanitizedEnv.GAM_NETWORK_CODE;
    delete sanitizedEnv.GAM_SERVICE_ACCOUNT_KEY_FILE;
    const noEnv = spawnSync(binPath, [], { env: sanitizedEnv, encoding: 'utf8', timeout: 5000 });
    if (noEnv.status !== 2) fail(`expected exit 2 without env, got ${noEnv.status}\nstdout: ${noEnv.stdout}\nstderr: ${noEnv.stderr}`);
    if (!(noEnv.stderr ?? '').includes('GAM_NETWORK_CODE')) fail(`stderr did not mention required env var:\n${noEnv.stderr}`);
    log('  ok: exit 2 with documented error');

    // Step 4b: full handshake (only when GAM env is present).
    if (process.env.GAM_NETWORK_CODE && process.env.GAM_SERVICE_ACCOUNT_KEY_FILE) {
      log('MCP handshake (env-present)...');
      const { stdout, stderr } = await handshake(binPath, process.env);
      if (stderr.trim().length > 0) fail(`stderr should be empty during a clean handshake; got:\n${stderr}`);
      const frames = stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const init = frames.find((f) => f.id === 1);
      const list = frames.find((f) => f.id === 2);
      const call = frames.find((f) => f.id === 3);
      if (!init?.result?.serverInfo) fail(`initialize did not return serverInfo: ${JSON.stringify(init)}`);
      const declaredVersion = init.result.serverInfo.version as string;
      const pkgVersion = (await import(join(repoRoot, 'package.json'), { with: { type: 'json' } })).default.version;
      if (declaredVersion !== pkgVersion) fail(`serverInfo.version=${declaredVersion} but package.json=${pkgVersion}`);
      log(`  ok: serverInfo.version ${declaredVersion}`);
      const tools = list?.result?.tools ?? [];
      if (tools.length === 0) fail('tools/list returned 0 tools');
      const empty = tools.filter((t: { inputSchema?: object }) => !t.inputSchema || Object.keys(t.inputSchema).length === 0);
      if (empty.length > 0) fail(`tools with empty inputSchema: ${empty.map((t: { name: string }) => t.name).join(', ')}`);
      log(`  ok: ${tools.length} tools, all with non-empty inputSchema`);
      if (call?.result?.isError) fail(`tools/call describe_schema returned isError:\n${JSON.stringify(call.result)}`);
      const schemaText = call?.result?.content?.[0]?.text;
      if (!schemaText || !JSON.parse(schemaText).rows?.length) fail('describe_schema returned empty rows');
      log('  ok: tools/call describe_schema returned rows');
    } else {
      log('GAM env not set; skipping full handshake (set GAM_NETWORK_CODE + GAM_SERVICE_ACCOUNT_KEY_FILE for the full check).');
    }

    log('PASS');
  } finally {
    cleanup();
  }
}

main().catch((e) => {
  process.stderr.write(`verify-pack: fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
