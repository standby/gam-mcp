import { describe, it, expect } from 'vitest';
import { describeSchemaTool } from '../../src/tools/describe_schema.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
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
    });
    expect('rows' in r).toBe(true);
    if ('rows' in r) {
      const kinds = new Set(r.rows!.map((row) => row.kind));
      expect(kinds.has('dimension')).toBe(true);
      expect(kinds.has('metric')).toBe(true);
      expect(r.row_count).toBeGreaterThanOrEqual(25);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
