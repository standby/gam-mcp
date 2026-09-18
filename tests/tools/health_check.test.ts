import { describe, it, expect } from 'vitest';
import { healthCheckTool } from '../../src/tools/health_check.js';
import { makeCtx } from '../helpers.js';
import { GamHttpError } from '../../src/gam-client.js';

describe('health_check', () => {
  it('reports ok when listEntities succeeds', async () => {
    const ctx = makeCtx({ entities: { company: [{ id: 1, name: 'AcmeCorp' }] } });
    const r = await healthCheckTool.handler({}, ctx);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows[0].status).toBe('ok');
    expect(r.rows[0].companies_visible).toBe('true');
    // A number, not a stringified one -- matches error.details.latency_ms
    // below (fix round 1: the two used to disagree in type).
    expect(typeof r.rows[0].latency_ms).toBe('number');
  });

  // I12 (spec §4.7, F15): a failed health check is an error envelope, not a
  // success envelope with status: 'failed' buried inside it. The diagnosis
  // attributeFailure() produces must still be readable -- it now lives in
  // error.details rather than in a row.
  describe('a listEntities failure is a GamErrorEnvelope naming the failing check', () => {
    // Primary path: the real REST client's listEntities throws a typed
    // GamHttpError (gam-client-rest.ts's httpError()) whenever GAM actually
    // answered with a non-2xx status, so classification reads e.status
    // directly rather than parsing it back out of a message string.
    describe('classified from a typed GamHttpError.status', () => {
      it('401 -> AUTH_FAILED, attributed to auth', async () => {
        const failingClient = {
          async listEntities() { throw new GamHttpError('listEntities', 401, 'UNAUTHENTICATED', 'bad credentials'); },
        };
        const ctx = makeCtx({}, { client: failingClient as any });
        const r = await healthCheckTool.handler({}, ctx);
        if (!('error' in r)) throw new Error(`expected an error envelope, got ${JSON.stringify(r)}`);
        expect(r.error.code).toBe('AUTH_FAILED');
        expect(r.error.details.check).toBe('listEntities');
        expect(r.error.details.attributed_cause).toMatch(/auth/i);
        expect(typeof r.error.details.latency_ms).toBe('number');
        expect(r.error.details.error_message).toMatch(/401/);
      });

      it('403 -> AUTH_FAILED, attributed to permission', async () => {
        const failingClient = {
          async listEntities() { throw new GamHttpError('listEntities', 403, 'PERMISSION_DENIED', 'no access'); },
        };
        const ctx = makeCtx({}, { client: failingClient as any });
        const r = await healthCheckTool.handler({}, ctx);
        if (!('error' in r)) throw new Error(`expected an error envelope, got ${JSON.stringify(r)}`);
        expect(r.error.code).toBe('AUTH_FAILED');
        expect(r.error.details.attributed_cause).toMatch(/permission/i);
      });

      it('404 -> INTERNAL_ERROR, attributed to wrong network code', async () => {
        const failingClient = {
          async listEntities() { throw new GamHttpError('listEntities', 404, 'NOT_FOUND', 'no such network'); },
        };
        const ctx = makeCtx({}, { client: failingClient as any });
        const r = await healthCheckTool.handler({}, ctx);
        if (!('error' in r)) throw new Error(`expected an error envelope, got ${JSON.stringify(r)}`);
        expect(r.error.code).toBe('INTERNAL_ERROR');
        expect(r.error.details.attributed_cause).toMatch(/wrong network code/i);
      });

      it('429 -> QUOTA_EXCEEDED, attributed to quota', async () => {
        const failingClient = {
          async listEntities() { throw new GamHttpError('listEntities', 429, 'RESOURCE_EXHAUSTED', 'slow down'); },
        };
        const ctx = makeCtx({}, { client: failingClient as any });
        const r = await healthCheckTool.handler({}, ctx);
        if (!('error' in r)) throw new Error(`expected an error envelope, got ${JSON.stringify(r)}`);
        expect(r.error.code).toBe('QUOTA_EXCEEDED');
        expect(r.error.details.attributed_cause).toMatch(/quota/i);
      });

      it('an unmapped status (e.g. 500) falls through to the message heuristic', async () => {
        const failingClient = {
          async listEntities() { throw new GamHttpError('listEntities', 500, 'INTERNAL', 'server error'); },
        };
        const ctx = makeCtx({}, { client: failingClient as any });
        const r = await healthCheckTool.handler({}, ctx);
        if (!('error' in r)) throw new Error(`expected an error envelope, got ${JSON.stringify(r)}`);
        expect(r.error.code).toBe('INTERNAL_ERROR');
        expect(r.error.details.attributed_cause).toMatch(/unknown/i);
      });
    });

    // Fallback path: a failure with no HTTP status at all -- a network-level
    // error (ENOTFOUND/ECONNREFUSED/ETIMEDOUT) before any response existed,
    // or a bare Error from somewhere else in the call chain. Classification
    // must still work from the message.
    describe('classified from the message when there is no typed status', () => {
      it('a bare Error mentioning 401 still attributes to auth', async () => {
        const failingClient = {
          async listEntities() { throw new Error('listEntities 401: Unauthorized'); },
        };
        const ctx = makeCtx({}, { client: failingClient as any });
        const r = await healthCheckTool.handler({}, ctx);
        if (!('error' in r)) throw new Error(`expected an error envelope, got ${JSON.stringify(r)}`);
        expect(r.error.code).toBe('AUTH_FAILED');
        expect(r.error.details.attributed_cause).toMatch(/auth/i);
      });

      it('ENOTFOUND attributes to network, as INTERNAL_ERROR', async () => {
        const failingClient = {
          async listEntities() { throw new Error('getaddrinfo ENOTFOUND admanager.googleapis.com'); },
        };
        const ctx = makeCtx({}, { client: failingClient as any });
        const r = await healthCheckTool.handler({}, ctx);
        if (!('error' in r)) throw new Error(`expected an error envelope, got ${JSON.stringify(r)}`);
        expect(r.error.code).toBe('INTERNAL_ERROR');
        expect(r.error.details.attributed_cause).toMatch(/network/i);
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
  });
});
