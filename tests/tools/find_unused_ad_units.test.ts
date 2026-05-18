import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findUnusedAdUnitsTool } from '../../src/tools/find_unused_ad_units.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';

function csv(header: string[], rows: (string | number)[][]): Buffer {
  return gzipSync(Buffer.from([header.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n'));
}

describe('find_unused_ad_units', () => {
  it('flags ad units that did not appear in the report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fu-'));
    const now = new Date('2026-04-15T12:00:00Z');
    const r = await findUnusedAdUnitsTool.handler(
      findUnusedAdUnitsTool.input.parse({}),
      {
        client: createMockGamClient({
          entities: {
            ad_unit: [
              { id: 1, name: 'Active' },
              { id: 2, name: 'Codeless_A' },
              { id: 3, name: 'Codeless_B' },
            ],
          },
          reports: [{
            query: {
              dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
              metrics: ['AD_REQUESTS'],
            },
            csvGz: csv(
              ['AD_UNIT_ID', 'AD_UNIT_NAME', 'AD_REQUESTS'],
              [['1', 'Active', 50000]],
            ),
          }],
        }),
        output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
        timezone: 'UTC',
        logger: noopLogger(),
        now,
      },
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.rows!.map((x) => x.AD_UNIT_NAME).sort()).toEqual(['Codeless_A', 'Codeless_B']);
    expect(r.rows!.every((x) => x.ad_requests === '0')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('treats ad units below min_requests as unused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fu-'));
    const now = new Date('2026-04-15T12:00:00Z');
    const r = await findUnusedAdUnitsTool.handler(
      findUnusedAdUnitsTool.input.parse({ min_requests: 1000 }),
      {
        client: createMockGamClient({
          entities: {
            ad_unit: [
              { id: 1, name: 'Healthy' },
              { id: 2, name: 'BarelyUsed' },
              { id: 3, name: 'Dead' },
            ],
          },
          reports: [{
            query: {
              dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
              metrics: ['AD_REQUESTS'],
            },
            csvGz: csv(
              ['AD_UNIT_ID', 'AD_UNIT_NAME', 'AD_REQUESTS'],
              [
                ['1', 'Healthy',    50000],
                ['2', 'BarelyUsed', 500],   // < 1000 threshold → unused
              ],
            ),
          }],
        }),
        output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
        timezone: 'UTC',
        logger: noopLogger(),
        now,
      },
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.rows!.map((x) => x.AD_UNIT_NAME)).toEqual(['Dead', 'BarelyUsed']);
    rmSync(dir, { recursive: true, force: true });
  });
});
