import { createMockGamClient, type DateRange, type MockState, type ReportQuery } from '../src/gam-client.js';
import { reportDefinition, type ReportDefinition } from '../src/report-definition.js';
import { noopLogger } from '../src/log.js';
import type { ToolContext } from '../src/report-tool-builder.js';

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
