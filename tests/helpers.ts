import { createMockGamClient, type DateRange, type GAMClient, type MockState, type ReportQuery } from '../src/gam-client.js';
import { createRestGamClient, withRetries } from '../src/gam-client-rest.js';
import { reportDefinition, type ReportDefinition } from '../src/report-definition.js';
import { noopLogger } from '../src/log.js';
import type { ToolContext } from '../src/report-tool-builder.js';
import type { Provenance, ResultEnvelope } from '../src/envelope.js';
import type { FakeGam } from './fake-gam.js';

export const NETWORK = '1234';

// The network the mock client's getNetwork, the fake GAM and makeCtx describe.
export const TEST_NETWORK = { networkCode: NETWORK, timeZone: 'Asia/Tokyo', currencyCode: 'USD' };

// A context over the mock client that never sleeps between polls.
export function makeCtx(state: MockState = {}, over: Partial<ToolContext> = {}): ToolContext {
  return {
    client: createMockGamClient({ networkCode: NETWORK, ...state }),
    logger: noopLogger(),
    timezone: 'Asia/Tokyo',
    reportTimeZone: TEST_NETWORK.timeZone,
    currencyCode: TEST_NETWORK.currencyCode,
    networkCode: NETWORK,
    now: new Date('2026-09-17T04:00:00Z'),
    sleep: async () => {},
    ...over,
  };
}

// The definition the report path builds for a query, and hands to defineReport.
export function definitionFor(query: ReportQuery, range: DateRange): ReportDefinition {
  return reportDefinition(query, range, TEST_NETWORK);
}

// A REST client over a fake GAM. `retries` mirrors how a real process wraps
// its fetch (withRetries, baseDelayMs 1 so tests never wait on real time).
export function clientFor(gam: FakeGam, retries = false): GAMClient {
  const fetchImpl = retries ? withRetries(gam.fetch, { baseDelayMs: 1 }) : gam.fetch;
  return createRestGamClient({ networkCode: NETWORK, fetchImpl });
}

// A ToolContext over that REST client; a fresh one stands for a new process,
// since per-client memory is keyed by the client object.
export function restCtx(gam: FakeGam, over: Partial<ToolContext> = {}, retries = false): ToolContext {
  return makeCtx({}, { client: clientFor(gam, retries), ...over });
}

// A successful result envelope, unwrapped from the error/success union tools
// and report-exec return; throws if the call actually failed.
export type Page = ResultEnvelope & { provenance: Provenance };
export function ok(r: unknown): Page {
  if (r && typeof r === 'object' && 'error' in r) throw new Error(JSON.stringify(r));
  return r as Page;
}
