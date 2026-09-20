import { ReportFilterRejectedError, type GAMClient } from './gam-client.js';
import type { Logger } from './log.js';
import { definitionRange, type ReportDefinition } from './report-definition.js';
import { differingKeys, reportName, sameDefinition } from './report-key.js';
import { Lru } from './lru.js';

// Report names remembered per client; the server builds one client per process.
export const REUSE_MAP_MAX = 1000;

type ReuseState = { byKey: Lru<string, string>; filterRejectionLogged: boolean };
const states = new WeakMap<object, ReuseState>();

function stateFor(client: GAMClient): ReuseState {
  let state = states.get(client);
  if (!state) {
    state = { byKey: new Lru(REUSE_MAP_MAX), filterRejectionLogged: false };
    states.set(client, state);
  }
  return state;
}

// Forgets the report remembered for `key`, which GAM no longer has.
export function forgetReport(client: GAMClient, key: string): void {
  stateFor(client).byKey.delete(key);
}

// The report that runs `definition` (spec §2.2): one this process already
// used, else one GAM lists under the definition's name whose stored
// definition is the same after normalisation, else a new one. `key` is
// definitionHash(definition), the same value the report is named from.
export async function findOrCreateReport(
  ctx: { client: GAMClient; logger: Logger },
  definition: ReportDefinition,
  key: string,
  tool: string,
): Promise<string> {
  const state = stateFor(ctx.client);
  const known = state.byKey.get(key);
  if (known) return known;
  const displayName = reportName(key);
  let report: string | undefined;
  try {
    const listed = await ctx.client.listReports({ displayName });
    report = listed.find((r) => sameDefinition(r.definition, definition))?.name;
    if (!report && listed.length > 0) {
      ctx.logger.warn('report.name_taken', {
        tool,
        display_name: displayName,
        listed: listed.length,
        differing_keys: [...new Set(listed.flatMap((r) => differingKeys(r.definition, definition)))].sort(),
      });
    }
  } catch (e) {
    if (!(e instanceof ReportFilterRejectedError)) throw e;
    // Without the filter there is no cheap way to find the report: create one.
    if (!state.filterRejectionLogged) {
      state.filterRejectionLogged = true;
      ctx.logger.warn('report.list_filter_rejected', { tool, status: e.status });
    }
  }
  if (report) {
    ctx.logger.debug('report.reused', { tool, report, display_name: displayName });
  } else {
    const range = definitionRange(definition);
    ctx.logger.info('report.create', {
      tool,
      display_name: displayName,
      dimensions: definition.dimensions,
      metrics: definition.metrics,
      date_start: range?.start ?? null,
      date_end: range?.end ?? null,
    });
    report = (await ctx.client.defineReport(definition)).report;
  }
  state.byKey.set(key, report);
  return report;
}
