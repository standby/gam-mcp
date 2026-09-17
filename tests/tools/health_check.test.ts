import { describe, it, expect } from 'vitest';
import { healthCheckTool } from '../../src/tools/health_check.js';
import { makeCtx } from '../helpers.js';

describe('health_check', () => {
  it('reports ok when listEntities succeeds', async () => {
    const ctx = makeCtx({ entities: { company: [{ id: 1, name: 'AcmeCorp' }] } });
    const r = await healthCheckTool.handler({}, ctx);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows[0].status).toBe('ok');
    expect(r.rows[0].companies_visible).toBe('true');
  });

  it('attributes auth failures to "auth"', async () => {
    // listEntities that throws with a 401-shaped message
    const failingClient = {
      async listEntities() { throw new Error('listEntities 401: Unauthorized'); },
    };
    const ctx = makeCtx({}, { client: failingClient as any });
    const r = await healthCheckTool.handler({}, ctx);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows[0].status).toBe('failed');
    expect(r.rows[0].attributed_cause).toMatch(/auth/i);
  });

  it('attributes 403 to permission', async () => {
    const failingClient = {
      async listEntities() { throw new Error('listEntities 403: Forbidden'); },
    };
    const ctx = makeCtx({}, { client: failingClient as any });
    const r = await healthCheckTool.handler({}, ctx);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows[0].attributed_cause).toMatch(/permission/i);
  });
});
