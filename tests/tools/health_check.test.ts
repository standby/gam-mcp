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

  // I12 (spec §4.7, F15): a failed health check is an error envelope, not a
  // success envelope with status: 'failed' buried inside it. The diagnosis
  // attributeFailure() produces must still be readable -- it now lives in
  // error.details rather than in a row.
  it('a listEntities failure is a GamErrorEnvelope naming the failing check', async () => {
    const failingClient = {
      async listEntities() { throw new Error('listEntities 401: Unauthorized'); },
    };
    const ctx = makeCtx({}, { client: failingClient as any });
    const r = await healthCheckTool.handler({}, ctx);
    if (!('error' in r)) throw new Error(`expected an error envelope, got ${JSON.stringify(r)}`);
    expect(r.error.code).toBe('AUTH_FAILED');
    expect(r.error.details.check).toBe('listEntities');
    expect(r.error.details.attributed_cause).toMatch(/auth/i);
    expect(r.error.details.error_message).toMatch(/401/);
  });

  it('attributes 403 to permission, still as AUTH_FAILED', async () => {
    const failingClient = {
      async listEntities() { throw new Error('listEntities 403: Forbidden'); },
    };
    const ctx = makeCtx({}, { client: failingClient as any });
    const r = await healthCheckTool.handler({}, ctx);
    if (!('error' in r)) throw new Error(`expected an error envelope, got ${JSON.stringify(r)}`);
    expect(r.error.code).toBe('AUTH_FAILED');
    expect(r.error.details.attributed_cause).toMatch(/permission/i);
  });

  it('attributes 429 to quota as QUOTA_EXCEEDED', async () => {
    const failingClient = {
      async listEntities() { throw new Error('listEntities 429: Too Many Requests'); },
    };
    const ctx = makeCtx({}, { client: failingClient as any });
    const r = await healthCheckTool.handler({}, ctx);
    if (!('error' in r)) throw new Error(`expected an error envelope, got ${JSON.stringify(r)}`);
    expect(r.error.code).toBe('QUOTA_EXCEEDED');
    expect(r.error.details.attributed_cause).toMatch(/quota/i);
  });

  it('falls back to INTERNAL_ERROR for an unrecognized failure', async () => {
    const failingClient = {
      async listEntities() { throw new Error('listEntities: socket hang up'); },
    };
    const ctx = makeCtx({}, { client: failingClient as any });
    const r = await healthCheckTool.handler({}, ctx);
    if (!('error' in r)) throw new Error(`expected an error envelope, got ${JSON.stringify(r)}`);
    expect(r.error.code).toBe('INTERNAL_ERROR');
    expect(r.error.details.attributed_cause).toMatch(/unknown/i);
  });
});
