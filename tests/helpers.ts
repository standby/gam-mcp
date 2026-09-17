import { createMockGamClient, type MockState } from '../src/gam-client.js';
import { noopLogger } from '../src/log.js';
import type { ToolContext } from '../src/report-tool-builder.js';

export const NETWORK = '1234';

// A context over the mock client that never sleeps between polls.
export function makeCtx(state: MockState = {}, over: Partial<ToolContext> = {}): ToolContext {
  return {
    client: createMockGamClient({ networkCode: NETWORK, ...state }),
    logger: noopLogger(),
    timezone: 'Asia/Tokyo',
    networkCode: NETWORK,
    now: new Date('2026-09-17T04:00:00Z'),
    sleep: async () => {},
    ...over,
  };
}
