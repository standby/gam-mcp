import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { healthCheckTool } from '../../src/tools/health_check.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';

function makeCtx(client: ReturnType<typeof createMockGamClient>) {
  const dir = mkdtempSync(join(tmpdir(), 'hc-'));
  return {
    dir,
    ctx: {
      client,
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'UTC',
      logger: noopLogger(),
    },
  };
}

describe('health_check', () => {
  it('reports ok when listEntities succeeds', async () => {
    const { ctx, dir } = makeCtx(createMockGamClient({
      entities: { company: [{ id: 1, name: 'AcmeCorp' }] },
    }));
    const r = await healthCheckTool.handler({}, ctx);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows![0].status).toBe('ok');
    expect(r.rows![0].companies_visible).toBe('true');
    rmSync(dir, { recursive: true, force: true });
  });

  it('attributes auth failures to "auth"', async () => {
    // listEntities that throws with a 401-shaped message
    const failingClient = {
      async listEntities() { throw new Error('listEntities 401: Unauthorized'); },
      async createReport() { throw new Error('not used'); },
      async pollOperation() { throw new Error('not used'); },
      async downloadReport() { throw new Error('not used'); },
    };
    const { ctx, dir } = makeCtx(failingClient as any);
    const r = await healthCheckTool.handler({}, ctx);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows![0].status).toBe('failed');
    expect(r.rows![0].attributed_cause).toMatch(/auth/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it('attributes 403 to permission', async () => {
    const failingClient = {
      async listEntities() { throw new Error('listEntities 403: Forbidden'); },
      async createReport() { throw new Error('not used'); },
      async pollOperation() { throw new Error('not used'); },
      async downloadReport() { throw new Error('not used'); },
    };
    const { ctx, dir } = makeCtx(failingClient as any);
    const r = await healthCheckTool.handler({}, ctx);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows![0].attributed_cause).toMatch(/permission/i);
    rmSync(dir, { recursive: true, force: true });
  });
});
