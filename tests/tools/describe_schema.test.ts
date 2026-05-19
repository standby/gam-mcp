import { describe, it, expect } from 'vitest';
import { describeSchemaTool } from '../../src/tools/describe_schema.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('describe_schema', () => {
  it('returns dimension and metric lists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-'));
    const args = describeSchemaTool.input.parse({});
    const r = await describeSchemaTool.handler(args, {
      client: createMockGamClient(),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 1000 }),
      timezone: 'UTC',
      logger: noopLogger(),
    });
    expect('rows' in r).toBe(true);
    if ('rows' in r) {
      const kinds = new Set(r.rows!.map((row) => row.kind));
      expect(kinds.has('dimension')).toBe(true);
      expect(kinds.has('metric')).toBe(true);
      expect(r.row_count).toBeGreaterThanOrEqual(25);
      // incompatible_with column surfaces curated conflicts (e.g.
      // KEY_VALUES_NAME ⊥ AD_REQUESTS) so callers see the matrix upfront.
      const kvn = r.rows!.find((row) => row.name === 'KEY_VALUES_NAME');
      expect(kvn?.incompatible_with).toContain('AD_REQUESTS');
      const adRequests = r.rows!.find((row) => row.name === 'AD_REQUESTS');
      expect(adRequests?.incompatible_with).toContain('KEY_VALUES_NAME');
      // Clean entries advertise an empty hint, not undefined, so the
      // schema column is non-null for every row.
      const date = r.rows!.find((row) => row.name === 'DATE');
      expect(date?.incompatible_with).toBe('');
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
